/**
 * The row grouping and the counts for the pi permission rule table.
 *
 * The file has one duty: select the rows one class or one profession gets,
 * compile the five rule sets for it, and count the table.
 *
 * Rule groups. A row with all three classes is a global row and goes into
 * `globalDeny` or `globalAsk`. A row with one class goes into `agentDeny`,
 * `agentAsk`, or `agentAllow` for that class. The engine has no global allow
 * set, so a global allow row is refused unless it names tools only: such a row
 * carries no command geometry and is copied into `agentAllow` for every class.
 * A command allow row would widen every class at once, so the schema refuses it.
 * A row with `roles` keeps its class group and narrows per profession in
 * `compileRole`.
 */

import type { RawRule, RuleSets } from "./command-segments.ts";
import {
	PERMISSION_CLASSES,
	ROLE_CLASS,
	isPermissionClass,
	isRole,
	type PermissionClass,
	type Role,
} from "./permission-class.ts";
import { fail, validateRows, type RuleRow } from "./permission-table.ts";
import { roleZone, rulesForRow } from "./permission-table-pattern.ts";

// --- grouping ---------------------------------------------------------------

function isGlobal(row: RuleRow): boolean {
	return PERMISSION_CLASSES.every((cls) => row.classes.includes(cls));
}

function targetSet(ruleSets: RuleSets, row: RuleRow, agentSide: boolean): RawRule[] {
	// An allow row always lands in `agentAllow`, because the engine has no global
	// allow set. A global allow row is a tool-name row, so every class gets it.
	if (row.verdict === "allow") return ruleSets.agentAllow;
	if (!agentSide) return row.verdict === "deny" ? ruleSets.globalDeny : ruleSets.globalAsk;
	if (row.verdict === "deny") return ruleSets.agentDeny;
	return ruleSets.agentAsk;
}

function emptyRuleSets(): RuleSets {
	return { globalDeny: [], agentDeny: [], globalAsk: [], agentAsk: [], agentAllow: [] };
}

function failUnknownClass(): never {
	return fail("<class>", "unknown class; a class carries no notes zone, so compile the role");
}

/**
 * The rows a class gets: every global row, then the class rows in table order.
 * A class carries no profession name, so a `roles` row is left to `rowsForRole`
 * and an unnamed agent falls to the mode default. A `roles` row that sets
 * `unnamed` joins the set, so an unnamed agent of that class gets the row.
 */
export function rowsForClass(rows: readonly RuleRow[], cls: PermissionClass): RuleRow[] {
	return rows.filter(
		(row) =>
			(row.roles === undefined || row.unnamed === true) &&
			(isGlobal(row) || row.classes.includes(cls)),
	);
}

/**
 * The rows one profession gets: every global row, then the class rows it is
 * named in. A row with `roles` applies only to the professions it names.
 */
export function rowsForRole(rows: readonly RuleRow[], role: Role): RuleRow[] {
	if (!isRole(role)) fail("<role>", `unknown role "${String(role)}"`);
	const cls = ROLE_CLASS[role];
	return rows.filter(
		(row) =>
			(isGlobal(row) || row.classes.includes(cls)) &&
			(row.roles === undefined || row.roles.includes(role)),
	);
}

/**
 * The five rule sets for one class. A class has no notes zone, so a `notes:own`
 * row binds to no zone here and matches nothing; compile the role for that row.
 * The row set comes from `rowsForClass`, so one filter decides which rows a
 * class holds.
 */
export function compileClass(rows: readonly RuleRow[], cls: PermissionClass): RuleSets {
	validateRows(rows);
	if (!isPermissionClass(cls)) return failUnknownClass();
	const sets = emptyRuleSets();
	for (const row of rowsForClass(rows, cls)) {
		targetSet(sets, row, !isGlobal(row)).push(...rulesForRow(row, null));
	}
	return sets;
}

/** The five rule sets for one role: its class rows with its own notes zone. */
export function compileRole(rows: readonly RuleRow[], role: Role): RuleSets {
	if (!isRole(role)) fail("<role>", `unknown role "${String(role)}"`);
	const zone = roleZone(role);
	validateRows(rows);
	const sets = emptyRuleSets();
	for (const row of rowsForRole(rows, role)) {
		targetSet(sets, row, !isGlobal(row)).push(...rulesForRow(row, zone));
	}
	return sets;
}

export type RowGroup = "global" | PermissionClass;

export interface TableCounts {
	total: number;
	uniqueIds: number;
	byGroup: Record<RowGroup, number>;
	byClass: Record<PermissionClass, number>;
}

export interface CompiledTable {
	counts: TableCounts;
	classes: Record<PermissionClass, RuleSets>;
}

export function rowsForGroup(rows: readonly RuleRow[], group: RowGroup): RuleRow[] {
	if (group === "global") return rows.filter(isGlobal);
	return rows.filter((row) => !isGlobal(row) && row.classes.length === 1 && row.classes[0] === group);
}

export function countTable(rows: readonly RuleRow[]): TableCounts {
	validateRows(rows);
	return {
		total: rows.length,
		uniqueIds: new Set(rows.map((row) => row.id)).size,
		byGroup: {
			global: rowsForGroup(rows, "global").length,
			reader: rowsForGroup(rows, "reader").length,
			worker: rowsForGroup(rows, "worker").length,
			orchestrator: rowsForGroup(rows, "orchestrator").length,
		},
		byClass: {
			reader: rowsForClass(rows, "reader").length,
			worker: rowsForClass(rows, "worker").length,
			orchestrator: rowsForClass(rows, "orchestrator").length,
		},
	};
}

/** Compile every class. `permissions.ts` wires one class per session. */
export function compileTable(rows: readonly RuleRow[]): CompiledTable {
	return {
		counts: countTable(rows),
		classes: {
			reader: compileClass(rows, "reader"),
			worker: compileClass(rows, "worker"),
			orchestrator: compileClass(rows, "orchestrator"),
		},
	};
}
