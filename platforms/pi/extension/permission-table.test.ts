/**
 * Tests for the permission rule table and its compiler.
 *
 *   node --experimental-strip-types --test \
 *     platforms/pi/extension/permission-table.test.ts
 *
 * Covers the row counts, the five rule-set shape the engine consumes, the
 * refused rows, the parity ledger over the 310 recorded frontmatter entries and
 * the 17 recorded global entries, the fence rows that close a former allow hole,
 * the per-role write zones, and the recorded narrowings. The differential gate
 * over the live legacy rules lives in permission-table.differential.test.ts. The
 * file stays whole because the table, its compiler, and its ledger are one unit.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { RawRule, RuleSets } from "./command-segments.ts";
import {
	CLASS_ORDER,
	FLAG_CLASSES,
	LADDER,
	PATH_VALUE,
	ROLE_CLASS,
	ROLE_NOTES,
	TAIL,
	TAIL_ONLY_CLASSES,
	compileClass,
	compileRole,
	compileTable,
	countTable,
	isPathValue,
	roleZone,
	rowsForClass,
	rowsForGroup,
	rowsForRole,
	rulesForRow,
	validateRows,
	type Role,
	type RoleClass,
	type RuleRow,
} from "./permission-table.ts";
import { GIT_DIFF_FAMILY, GIT_READ, RULE_ROWS } from "./permissions.table.ts";
import { compileGateSource } from "./permissions.ts";
import type { AgentConfig } from "./resolver.ts";
import {
	DELETIONS,
	FENCED,
	FRONTMATTER_ENTRY_COUNT,
	GLOBAL_ENTRY_COUNT,
	LEGACY,
	LEGACY_COUNTS,
	NARROWED,
	ROW_RATIONALE,
} from "./permission-table.parity.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FRONTMATTER_DIR = path.join(repoRoot, "platforms", "pi", "frontmatters");
/** One neutral fixture root. No test carries a real home path. */
const FIXTURE_ROOT = "/fixture";
/**
 * The live global permission file is unversioned, and the install notes tell the
 * owner to clean it, so the test never reads it by default and never hardcodes a
 * home path. Set `PI_TEST_READ_GLOBAL_PERMISSIONS=1` to opt in; the path comes
 * from the home directory call.
 */
const GLOBAL_FILE = process.env.PI_TEST_READ_GLOBAL_PERMISSIONS
	? path.join(homedir(), ".pi", "agent", "permissions.json")
	: null;

const ROLES: readonly Role[] = [
	"orchestrator",
	"planner",
	"implementer",
	"tester",
	"reviewer",
	"researcher",
	"mascot",
];

type Section = "allow" | "ask" | "deny";
const SECTIONS: readonly Section[] = ["allow", "ask", "deny"];

const RULE_SET_KEYS = ["agentAllow", "agentAsk", "agentDeny", "globalAsk", "globalDeny"];

function ruleCount(sets: RuleSets): number {
	return (
		sets.globalDeny.length +
		sets.globalAsk.length +
		sets.agentDeny.length +
		sets.agentAsk.length +
		sets.agentAllow.length
	);
}

function matches(rules: readonly RawRule[], tool: string, probe: string): boolean {
	return rules.some((rule) => rule.tool === tool && new RegExp(rule.match, "i").test(probe));
}

/** True when a class allow rule lets the probe through, as the engine tests it. */
function allowMatches(sets: RuleSets, tool: string, probe: string): boolean {
	return matches(sets.agentAllow, tool, probe);
}

function denyMatches(sets: RuleSets, tool: string, probe: string): boolean {
	return matches(sets.globalDeny, tool, probe) || matches(sets.agentDeny, tool, probe);
}

function askMatches(sets: RuleSets, tool: string, probe: string): boolean {
	return matches(sets.globalAsk, tool, probe) || matches(sets.agentAsk, tool, probe);
}

/** The verdict the engine reaches for one probe: deny, then ask, then allow. */
function verdictOf(sets: RuleSets, tool: string, probe: string): "deny" | "ask" | "allow" | "none" {
	if (denyMatches(sets, tool, probe)) return "deny";
	if (askMatches(sets, tool, probe)) return "ask";
	if (allowMatches(sets, tool, probe)) return "allow";
	return "none";
}

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

/** The analysis tools that write or act, so no allow row names them. */
const ANALYSIS_WRITE_TOOLS = ["ast_grep_replace", "lens_diagnostic_mark", "lsp_navigation"];

/**
 * The verdict one profession reaches. Deny-by-default mode turns an unmatched
 * segment into a deny, so `none` reads as `deny` for a profession.
 */
function gateVerdict(role: Role, tool: string, probe: string): "deny" | "ask" | "allow" {
	const verdict = verdictOf(compileRole(RULE_ROWS, role), tool, probe);
	return verdict === "none" ? "deny" : verdict;
}

// --- row counts -------------------------------------------------------------

test("the table holds 81 rows: 22 global, 14 reader, 20 worker, 25 orchestrator", () => {
	const counts = countTable(RULE_ROWS);
	assert.equal(counts.total, 81);
	assert.equal(counts.byGroup.global, 22);
	assert.equal(counts.byGroup.reader, 14);
	assert.equal(counts.byGroup.worker, 20);
	assert.equal(counts.byGroup.orchestrator, 25);
});

test("every class resolves to 36, 42, and 47 rows", () => {
	const counts = countTable(RULE_ROWS);
	assert.equal(counts.byClass.reader, 36);
	assert.equal(counts.byClass.worker, 42);
	assert.equal(counts.byClass.orchestrator, 47);
	assert.deepEqual(rowsForClass(RULE_ROWS, "reader"), [...rowsForGroup(RULE_ROWS, "global"), ...rowsForGroup(RULE_ROWS, "reader")]);
});

test("the 81 rows carry 58 ids: a shared rule is one row per class", () => {
	// One id is one rule. A rule that three classes share is three rows with one
	// id, so the id count is the number of distinct rules, not of rows.
	assert.equal(countTable(RULE_ROWS).uniqueIds, 58);
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
});

test("every row reaches a class set and every flag class is used", () => {
	const { classes } = compileTable(RULE_ROWS);
	for (const cls of CLASS_ORDER) {
		// Every row a class owns emits one rule per tool it names: no row is dropped.
		const expected = RULE_ROWS.filter(
			(row) => row.classes.length === CLASS_ORDER.length || row.classes.includes(cls),
		).reduce((total, row) => total + row.tool.trim().split(/\s+/).length, 0);
		assert.equal(ruleCount(classes[cls]), expected, cls);
	}
	const used = new Set<string>(RULE_ROWS.map((row) => row.flags ?? "none"));
	for (const flags of FLAG_CLASSES) {
		assert.ok(
			used.has(flags) || TAIL_ONLY_CLASSES.includes(flags),
			`flag class ${flags} is unreachable`,
		);
	}
});

// --- compiled shape ---------------------------------------------------------

test("the compiler produces the five rule sets the engine consumes", () => {
	const { classes } = compileTable(RULE_ROWS);
	for (const cls of CLASS_ORDER) {
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

test("the ten analysis tools allow for every class and the write tools stay denied", () => {
	for (const cls of CLASS_ORDER) {
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
		for (const rule of [...compileClass(RULE_ROWS, cls).agentAllow, ...compileClass(RULE_ROWS, cls).agentDeny]) {
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

test("a reader class runs no test or build runner", () => {
	for (const role of ["planner", "reviewer", "researcher", "mascot"] as Role[]) {
		const sets = compileRole(RULE_ROWS, role);
		for (const probe of [
			"npm test",
			"npm run typecheck",
			"npm run lint",
			"cargo test",
			"cargo nextest",
			"cargo build",
			"cargo clippy",
			"cargo deny check",
			"pytest",
			"python -m pytest",
			"mypy",
			"ruff",
			"npm run build",
			"tsc",
			"tsc --noEmit",
			"docker ps",
		]) {
			assert.equal(allowMatches(sets, "bash", probe), false, `${role} runs ${probe}`);
		}
		for (const probe of ["rustc -V", "cargo --version", "cargo metadata", "cargo tree", "rustup show", "npm root", "npm prefix"]) {
			assert.equal(allowMatches(sets, "bash", probe), true, `${role} lost the probe ${probe}`);
		}
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
		for (const probe of [
			`git ${verb}`,
			`git -C /x ${verb}`,
			`git --no-pager ${verb}`,
			`git -p ${verb}`,
			`cd /x && git ${verb}`,
		]) {
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
	for (const probe of [
		"git merge --no-ff topic",
		"git merge --squash topic",
		"git commit --fixup=HEAD",
		"git commit --file m",
		"git commit -s",
		"git tag --format=x",
		// The force ladder is a tag form only, so it never reaches commit or merge.
		"git commit --force",
		"git commit -f m",
		"git merge --force",
	]) {
		assert.equal(askMatches(orchestrator, "bash", probe), false, probe);
		assert.equal(allowMatches(orchestrator, "bash", probe), true, probe);
	}
	// A gated form still matches the plain history allow row; the ask wins by
	// precedence, so only the ask is asserted here.
	for (const probe of [
		"git tag --force v1",
		"git tag --forc v1",
		"git tag --for v1",
		"git tag --fo v1",
		"git tag --f v1",
		"git tag -f v1", "git -C /x commit --amend",
		"git merge --strategy=ours topic",
		"git merge --strat=ours topic",
		"git pull -s ours",
		"git pull ext::sh -c id",
		"git merge ext::sh",
		"git rebase -s recursive topic",
	]) {
		assert.equal(askMatches(orchestrator, "bash", probe), true, probe);
	}
});

test("a quoted commit message never reaches the exception scan", () => {
	const orchestrator = compileClass(RULE_ROWS, "orchestrator");
	for (const probe of [
		'git commit -m "run the soft reset"',
		'git commit -m "a --amend b"',
		'git commit -m "--force"',
		"git commit -m soft",
		"git commit -m -s",
	]) {
		assert.equal(askMatches(orchestrator, "bash", probe), false, probe);
		assert.equal(allowMatches(orchestrator, "bash", probe), true, probe);
	}
});

test("an unlisted global option with a separate value word asks", () => {
	const orchestrator = compileClass(RULE_ROWS, "orchestrator");
	for (const probe of [
		"git --work-tree /x commit",
		"git --git-dir /x/.git commit",
		"git --git-dir=X commit",
	]) {
		assert.equal(askMatches(orchestrator, "bash", probe), true, probe);
		assert.equal(allowMatches(orchestrator, "bash", probe), false, probe);
	}
	// The config override is the lowercase form that carries a key and an equals
	// sign, and it asks.
	assert.equal(askMatches(orchestrator, "bash", "git -c key=value commit"), true);
	// A `-C <path>` is one of the three listed global options, so every path form
	// allows, including a relative path, a path with an equals sign, and a bare
	// repository directory.
	for (const probe of [
		"git -C ./x commit",
		"git -C /x commit",
		"git -C /x=y commit",
		"git -C ../other commit",
		"git -C repo.git commit",
	]) {
		assert.equal(askMatches(orchestrator, "bash", probe), false, probe);
		assert.equal(allowMatches(orchestrator, "bash", probe), true, probe);
	}
});

test("a -C value shaped like a config key asks instead of riding the path slot", () => {
	// Before the fix the plain history row took any `-C` value, so it allowed
	// every form below. A config key in the value runs code on the next command.
	const probes = [
		"git -C core.hooksPath commit",
		"git -C core.hooksPath commit -m x",
		"git -C core.hooksPath=/x commit",
		"git -C remote.origin.url commit",
		"git -c core.hooksPath=/x commit",
	];
	const orchestrator = compileClass(RULE_ROWS, "orchestrator");
	for (const probe of probes) {
		assert.equal(allowMatches(orchestrator, "bash", probe), false, probe);
		assert.equal(askMatches(orchestrator, "bash", probe), true, probe);
	}
	// A worker and a reader keep their own verdict: the history deny row.
	for (const [name, sets] of [
		["worker", compileClass(RULE_ROWS, "worker")],
		["reader", compileClass(RULE_ROWS, "reader")],
	] as const) {
		for (const probe of probes) {
			assert.equal(allowMatches(sets, "bash", probe), false, `${name}: ${probe}`);
			assert.equal(denyMatches(sets, "bash", probe), true, `${name}: ${probe}`);
		}
	}
});

test("the branch listing forms allow and a branch write form never allows", () => {
	for (const cls of CLASS_ORDER) {
		const sets = compileClass(RULE_ROWS, cls);
		for (const probe of [
			"git branch",
			"git branch -l",
			"git branch --list",
			"git branch -a",
			"git branch -r",
			"git branch --show-current",
			"git branch --contains main",
			"git branch -r --contains main",
			"git -C /x branch -r --contains main",
		]) {
			assert.equal(allowMatches(sets, "bash", probe), true, `${cls}: ${probe}`);
		}
		for (const probe of [
			"git branch -d v1",
			"git branch -D v1",
			"git branch -m x",
			"git branch --force x",
			"git branch new",
			"git -C /x branch -d v1",
		]) {
			assert.equal(allowMatches(sets, "bash", probe), false, `${cls}: ${probe}`);
			assert.equal(askMatches(sets, "bash", probe), false, `${cls}: ${probe}`);
		}
	}
});

test("every read verb that accepts a write flag is also fenced", () => {
	const { classes } = compileTable(RULE_ROWS);
	for (const verb of GIT_DIFF_FAMILY) {
		for (const cls of CLASS_ORDER) {
			assert.equal(
				denyMatches(classes[cls], "bash", `git ${verb} --textconv f`),
				true,
				`${cls}: git ${verb} --textconv`,
			);
			assert.equal(
				denyMatches(classes[cls], "bash", `git ${verb} --textc f`),
				true,
				`${cls}: git ${verb} --textc`,
			);
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
	for (const probe of ["npm test", "npm run typecheck", "npm run lint"]) {
		assert.equal(allowMatches(orchestrator, "bash", probe), true, probe);
	}
	for (const probe of ["npm test --watch", "npm test extra", "npm run lint --fix"]) {
		assert.equal(allowMatches(orchestrator, "bash", probe), false, probe);
	}
	// The cargo verification rows keep a trailing argument.
	assert.equal(allowMatches(orchestrator, "bash", "cargo nextest --all"), true);
});

/** The verification commands the retired tester and implementer lists carried. */
const WORKER_VERIFY_PROBES = [
	"npm test",
	"npm run typecheck",
	"npm run build",
	"tsc",
	"tsc --noEmit",
	"pytest",
	"python -m pytest",
	"mypy",
	"ruff",
	"cargo check",
	"cargo clippy",
	"cargo build",
	"cargo test",
	"cargo nextest",
];

/** True when one named row's own pattern covers the probe. */
function rowMatches(id: string, probe: string): boolean {
	return RULE_ROWS.filter((row) => row.id === id).some((row) => matches(rulesForRow(row), "bash", probe));
}

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
	for (const probe of [
		"cd /fixture && npm test",
		"cd /fixture && npm run build",
		"cd /fixture && pytest",
		"cd /fixture && tsc",
		// The four fold-defeat forms: a leading assignment, a doubled space
		// before the operator, two chained prefixes, and a substituted form.
		"A=1 cd /fixture && npm test",
		"cd /fixture  && npm test",
		"cd /fixture && cd /other && npm test",
		"$(cd /fixture && npm test)",
	]) {
		for (const role of ["orchestrator", "implementer", "tester"] as Role[]) {
			assert.equal(allowMatches(compileRole(RULE_ROWS, role), "bash", probe), false, `${role}: ${probe}`);
		}
	}
	// The git fold stays: doctrine allows a leading `cd x &&` for the six verbs.
	assert.equal(
		allowMatches(compileClass(RULE_ROWS, "orchestrator"), "bash", "cd /fixture && git status"),
		true,
	);
});

test("a reader role still denies npm test", () => {
	for (const role of ["planner", "reviewer", "researcher", "mascot"] as Role[]) {
		for (const probe of ["npm test", "npm run typecheck", "npm run build", "tsc", "tsc --noEmit", "pytest"]) {
			assert.equal(allowMatches(compileRole(RULE_ROWS, role), "bash", probe), false, `${role} runs ${probe}`);
		}
	}
});

test("a trailing flag on npm test is judged by the orchestrator row rule, not the worker row", () => {
	// Both rows carry the bare flag class, so both end at the script word.
	assert.equal(rowMatches("shell.verify", "npm test"), true, "the orchestrator row lost npm test");
	assert.equal(rowMatches("shell.verify.worker", "npm test"), true, "the worker row lost npm test");
	for (const probe of ["npm test --watch", "npm test extra"]) {
		assert.equal(rowMatches("shell.verify", probe), false, `the orchestrator row covers ${probe}`);
		assert.equal(rowMatches("shell.verify.worker", probe), false, `the worker row covers ${probe}`);
	}
	// The worker row keeps the bare forms the retired lists carried.
	for (const probe of [
		"tsc",
		"tsc --noEmit",
		"pytest",
		"python -m pytest",
		"mypy",
		"ruff",
		"cargo nextest",
	]) {
		assert.equal(rowMatches("shell.verify.worker", probe), true, probe);
	}
	// A package script name is free text, so the script row takes any word.
	for (const probe of ["npm run typecheck", "npm run build"]) {
		assert.equal(rowMatches("shell.verify.script", probe), true, probe);
	}
});

test("a soft reset, a prefix option, and a wrapper prefix on a history verb ask", () => {
	const orchestrator = compileClass(RULE_ROWS, "orchestrator");
	for (const probe of [
		"git reset --soft HEAD~3",
		"git -C /x reset --soft HEAD~3",
		"git --git-dir=/x/.git commit -m done",
		"git -C /x --git-dir=/x/.git commit",
		"git --exec-path=/x commit",
		"git --no-pager --git-dir=/x/.git commit",
		"env A=1 git commit -m done",
		"env A=1 git --git-dir=/x/.git commit",
		"timeout 5 git commit -m done",
		"A=1 git rebase --continue",
	]) {
		assert.equal(askMatches(orchestrator, "bash", probe), true, probe);
		assert.equal(allowMatches(orchestrator, "bash", probe), false, probe);
	}
});

test("the plain history forms never ask and always allow", () => {
	const orchestrator = compileClass(RULE_ROWS, "orchestrator");
	for (const probe of [
		"git add .",
		"git commit -m done",
		"git -C /x commit -m done",
		"git --no-pager commit",
		"git -p commit",
		"cd /x && git tag v1",
	]) {
		assert.equal(askMatches(orchestrator, "bash", probe), false, probe);
		assert.equal(allowMatches(orchestrator, "bash", probe), true, probe);
	}
});

test("the git directory option takes a path, never a config key", () => {
	const orchestrator = compileClass(RULE_ROWS, "orchestrator");
	for (const path of ["/x", "/x=y", "../other", "repo.git", "x.y/z", "/x.y"]) {
		for (const probe of [`git -C ${path} status`, `git -C ${path} commit`]) {
			assert.equal(allowMatches(orchestrator, "bash", probe), true, probe);
			assert.equal(askMatches(orchestrator, "bash", probe), false, probe);
			assert.equal(verdictOf(orchestrator, "bash", probe), "allow", probe);
		}
	}
	// A value that fails the path grammar asks for the orchestrator. The two
	// spellings are one token to the engine, and a quoted or escaped value is
	// not a path either.
	for (const probe of [
		"git -C core.hooksPath commit",
		"git -C core.hooksPath=/x commit",
		"git -C 'diff.external=/tmp/x' diff",
		'git -C "core.hooksPath=/tmp/x" commit',
		"git -c core.editor=vim commit",
		"git -C \"core.hooksPath=/tmp/x\" commit",
	]) {
		assert.equal(allowMatches(orchestrator, "bash", probe), false, probe);
		assert.equal(askMatches(orchestrator, "bash", probe), true, probe);
		assert.equal(verdictOf(orchestrator, "bash", probe), "ask", probe);
	}
	// A reader holds no ask row for the form, so the deny-by-default default
	// blocks it, including the quoted spelling.
	for (const probe of [
		"git -c 'diff.external=/tmp/x' diff",
		"git -c 'core.fsmonitor=/tmp/x' status",
	]) {
		for (const role of ["planner", "reviewer", "researcher", "mascot"] as Role[]) {
			assert.equal(allowMatches(compileRole(RULE_ROWS, role), "bash", probe), false, `${role}: ${probe}`);
			assert.equal(gateVerdict(role, "bash", probe), "deny", `${role}: ${probe}`);
		}
	}
});

/** Values that satisfy the git directory-option path grammar. */
const PATH_PROBES = [
	"/x",
	"/x=y",
	"../other",
	"repo.git",
	"x.y/z",
	"/x.y",
	"./x",
	"~/x",
	"/x/y.git",
];

/** Values that do not: a quote, a backslash, no slash, or a bare key with an equals sign. */
const NON_PATH_PROBES = [
	"core.hooksPath",
	"core.hooksPath=/x",
	"remote.origin.url",
	"x=y",
	"repo",
	"/x\\y",
	"'/x'",
	'"/x"',
	'\\"/x\\"',
	"~x=y",
];

/** The allow rows that read the git directory-option slot. */
const SLOT_ALLOW_ROWS = RULE_ROWS.filter(
	(row) =>
		row.verdict === "allow" &&
		row.tool.split(/\s+/).includes("bash") &&
		(row.verb ?? []).includes("git"),
);

/** A probe the row matches when the slot value is a path. */
function slotProbe(row: RuleRow, value: string): string {
	const sub = (row.sub ?? [])[0] ?? "";
	const tail = row.id === "git.branch" ? " -l" : "";
	return `git -C ${value} ${sub}${tail}`.trim();
}

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
			assert.equal(
				matches(rules, "bash", slotProbe(row, value)),
				false,
				`${row.id} accepted the non-path value ${value}`,
			);
		}
	}
});

test("a commit message word never asks", () => {
	const orchestrator = compileClass(RULE_ROWS, "orchestrator");
	for (const probe of [
		'git commit -m "run the tests"',
		'git commit -m "push after review"',
		'git commit -m "open a pr"',
		'git commit -m "release v2"',
		"git commit -m run",
		"git -C /x commit -m push pr run release",
	]) {
		assert.equal(askMatches(orchestrator, "bash", probe), false, probe);
	}
	// The release ask still reaches the verb itself.
	for (const probe of ["git push", "git -C /x push", "gh pr", "gh run", "gh release"]) {
		assert.equal(askMatches(orchestrator, "bash", probe), true, probe);
	}
});

test("a soft reset, a prefix option, and a wrapper stay unallowed for the others", () => {
	const reader = compileClass(RULE_ROWS, "reader");
	const worker = compileClass(RULE_ROWS, "worker");
	for (const probe of ["git reset --soft HEAD~3", "git --git-dir=/x/.git commit", "env A=1 git commit"]) {
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
		for (const probe of [
			"git fetch origin main:refs/heads/main",
			"git fetch --depth=1 origin :main",
			"git fetch https://example.invalid/repository",
		]) {
			// The deny row wins over a fetch ask row, so the verdict is a deny.
			assert.equal(gateVerdict(role, "bash", probe), "deny", `${role}: ${probe}`);
		}
	}
});

test("the orchestrator keeps mkdir, sort, and uniq, and no other class gains them", () => {
	const orchestrator = compileClass(RULE_ROWS, "orchestrator");
	for (const probe of ["mkdir -p out", "sort in.txt", "uniq in.txt", "cd /x && mkdir -p y"]) {
		assert.equal(allowMatches(orchestrator, "bash", probe), true, probe);
	}
	for (const cls of ["reader", "worker"] as RoleClass[]) {
		for (const probe of ["mkdir -p out", "sort in.txt", "uniq in.txt"]) {
			assert.equal(allowMatches(compileClass(RULE_ROWS, cls), "bash", probe), false, `${cls}: ${probe}`);
		}
	}
});

test("a long-option abbreviation on a history verb asks", () => {
	const orchestrator = compileClass(RULE_ROWS, "orchestrator");
	for (const probe of [
		"git commit --amend",
		"git commit --amen",
		"git tag --force v1",
		"git tag --forc v1",
		"git pull --upload-pack=evil",
		"git pull --uplo=evil",
		"git merge --strategy=ours topic",
		"git merge --strat=ours topic",
		"git rebase -s recursive topic",
		"git add $FILE",
		"git add *",
	]) {
		assert.equal(askMatches(orchestrator, "bash", probe), true, probe);
	}
});

test("a tag delete denies at every abbreviation", () => {
	for (const flag of ["-d", "--d", "--de", "--del", "--dele", "--delet", "--delete"]) {
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
	for (const probe of ["git push", "git -C /x push", "git --no-pager push", "cd /x && git push", "env A=1 git push", "gh pr", "gh run", "gh release"]) {
		assert.equal(askMatches(orchestrator, "bash", probe), true, probe);
		assert.equal(allowMatches(orchestrator, "bash", probe), false, probe);
		assert.equal(denyMatches(reader, "bash", probe), true, probe);
		assert.equal(denyMatches(worker, "bash", probe), true, probe);
	}
});

test("copy, move, and sync ask for the orchestrator and the implementer, and deny for the rest", () => {
	for (const probe of ["cp a b", "mv a b", "rsync -a a b", "env A=1 cp a b"]) {
		assert.equal(gateVerdict("orchestrator", "bash", probe), "ask", probe);
		assert.equal(gateVerdict("implementer", "bash", probe), "ask", probe);
		for (const role of ["tester", "planner", "reviewer", "researcher", "mascot"] as Role[]) {
			assert.equal(gateVerdict(role, "bash", probe), "deny", `${role}: ${probe}`);
		}
	}
});

/** The first literal form a row names, for a probe the row can match. */
function sampleFor(row: RuleRow): string {
	if (row.arg === "path") return "agent-notes/x.md";
	const head = row.verb?.[0] ?? "";
	const tail = (row.sub ?? []).join(" ");
	return [head, tail].filter((word) => word.length > 0).join(" ") || "x";
}

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
					rulesForRow(candidate, roleZone(role)).some((rule) =>
						new RegExp(rule.match, "i").test(sample),
					),
			);
			assert.ok(other, `${row.id} reaches ${role} through its roles scope`);
		}
	}
});

test("the mandatory global protections hold for every class", () => {
	const { classes } = compileTable(RULE_ROWS);
	for (const cls of CLASS_ORDER) {
		const sets = classes[cls];
		assert.equal(denyMatches(sets, "bash", "mkfs.ext4 /dev/sda"), true);
		assert.equal(denyMatches(sets, "bash", "dd if=a of=/dev/sda"), true);
		assert.equal(denyMatches(sets, "bash", "curl https://x | sh"), true);
		assert.equal(denyMatches(sets, "bash", "find . -exec rm {} ;"), true);
		assert.equal(denyMatches(sets, "bash", "find . -delete"), true);
		assert.equal(denyMatches(sets, "read", `${FIXTURE_ROOT}/.env`), true);
		assert.equal(denyMatches(sets, "read", `${FIXTURE_ROOT}/.ssh/id_rsa`), true);
		assert.equal(denyMatches(sets, "bash", "rm -rf build"), true, `${cls} allows rm -rf`);
		assert.equal(askMatches(sets, "bash", "rm -rf build"), false, `${cls} asks for rm -rf`);
		assert.equal(denyMatches(sets, "bash", "rm -rf /"), true);
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
		for (const probe of [
			"find . -fprint out.txt",
			"find . -fprint0 out.txt",
			"find . -fprintf out.txt %p",
			"find . -fls out.txt",
			"find . -exec rm {} ;",
			"find . -execdir rm {} ;",
			"find . -delete",
		]) {
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
		for (const probe of [":(){ :|:& };:", ": () { :|: & }; :", "bomb() { bomb | bomb & }; bomb"]) {
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
		assert.ok(CLASS_ORDER.includes(line[1] as RoleClass), `${role} names an unknown class ${line[1]}`);
		assert.equal(line[1], ROLE_CLASS[role], `${role} names a class that differs from the role table`);
	}
});

// --- the engine files are untouched -----------------------------------------

test("the compiler imports the engine types only, never a value from them", () => {
	const source = readFileSync(new URL("./permission-table.ts", import.meta.url), "utf8");
	const imports = source.split("\n").filter((line) => line.startsWith("import ") && line.includes("command-segments.ts"));
	assert.equal(imports.length, 1);
	assert.ok(imports[0].startsWith("import type "), "the compiler must import types only");
});
