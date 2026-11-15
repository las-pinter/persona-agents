/**
 * The parity ledger and the frontmatter migration of the permission rule table.
 *
 * The file holds the ledger cases and the frontmatter end state; the compiled
 * shape stays in permission-table.shape.test.ts, the refused rows in
 * permission-table.validation.test.ts, the gate source in
 * permission-table.gate-source.test.ts, and the gate verdict cases in
 * permission-table.gate.test.ts and permission-table.gate-history.test.ts.
 */

import { test } from "node:test";
import * as assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { ROLE_NOTES, type RuleRow } from "./permission-table.ts";
import { compileRole } from "./permission-table-groups.ts";
import { roleZone } from "./permission-table-pattern.ts";
import {
	PERMISSION_CLASSES,
	ROLE_CLASS,
	isPermissionClass,
	type PermissionClass,
	type Role,
} from "./permission-class.ts";
import { RULE_ROWS } from "./permissions.table.ts";
import {
	DELETIONS,
	FRONTMATTER_ENTRY_COUNT,
	GLOBAL_ENTRY_COUNT,
	LEGACY,
	LEGACY_COUNTS,
	ROW_RATIONALE,
} from "./permission-table.parity.ts";
import { ROLES, RULE_SET_KEYS, denyMatches } from "./permission-table.test-helpers.ts";

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
