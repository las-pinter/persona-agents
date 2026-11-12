/**
 * Loader for the three permission layers.
 *
 * A session reads its rules in this order:
 *
 *   1. the shipped default file `platforms/pi/permissions.table.json`,
 *   2. the user override file `<agent dir>/permissions.table.json`,
 *   3. the live global overlay `<agent dir>/permissions.json`.
 *
 * The first two layers are row tables, and the same validator (`validateRows` in
 * `permission-table.ts`) runs on the default and on every row the override
 * supplies. The overlay keeps its own shape (`deny` and `ask` regex rows), so an
 * existing file keeps working. A row without a usable `match` fails the layer
 * here, so the compiler never drops it in silence. Every loaded rule records the
 * layer that produced it.
 *
 * A broken table layer fails closed. One line names the kind of file, the file,
 * and, when a row is at fault, the row id. The returned overlay then carries a
 * deny-all fence, so no tool call runs until the file is fixed. The global
 * overlay keeps this behavior from the earlier loader.
 *
 * No project-level table exists. The default path resolves from this module, the
 * override and overlay paths resolve from the home agent folder, and none of
 * them resolve from the working directory. A configured table or override path
 * must be absolute, and its real path is checked, so a symlink cannot reach a
 * repository path. A configured table or override path inside a git work tree is
 * refused with one log line: a repository may never grant itself a fence.
 *
 * Test hooks: `PI_PERMISSIONS_TABLE` sets the table path,
 * `PI_PERMISSIONS_TABLE_OVERRIDE` sets the override path, and
 * `PI_PERMISSIONS_FILE` sets the overlay path.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { rowFault, validateRow, validateRows, type RuleRow, type Verdict } from "./permission-table.ts";
import { recordLogLine } from "./ask-record.ts";
import { compileRegex, type RawRule } from "./command-segments.ts";

/** The environment variable that sets the shipped table path. */
export const TABLE_ENV = "PI_PERMISSIONS_TABLE";
/** The environment variable that sets the user override path. */
export const OVERRIDE_ENV = "PI_PERMISSIONS_TABLE_OVERRIDE";
/** The environment variable that sets the global overlay path. */
export const OVERLAY_ENV = "PI_PERMISSIONS_FILE";

/** The shipped default table, resolved from this module, never from the cwd. */
export const DEFAULT_TABLE_FILE = fileURLToPath(new URL("../permissions.table.json", import.meta.url));

/** The global overlay rows, one verdict list each. */
export interface OverlayRules {
	deny: RawRule[];
	ask: RawRule[];
}

/** The reason the deny-all fence reports when a table layer fails. */
export const FENCE_REASON = "The permission table could not be loaded, so every tool call is denied";

/** The result of one load of all three layers. */
export interface PermissionConfig {
	/** The default rows with the override applied, each stamped with its layer. */
	rows: RuleRow[];
	/** The overlay rows, each stamped with the `overlay` layer. */
	overlay: OverlayRules;
	/** One logged line per failed layer; a non-empty list means the fence is on. */
	errors: string[];
}

/** Explicit paths for a test or a probe. An absent field reads its default. */
export interface ConfigPaths {
	table?: string;
	override?: string;
	overlay?: string;
}

/** The shipped default table path. */
export function defaultTableFile(): string {
	return DEFAULT_TABLE_FILE;
}

/** The table path: the test hook first, then the shipped default. */
export function tableFile(): string {
	return process.env[TABLE_ENV] || DEFAULT_TABLE_FILE;
}

/** The override path: the test hook first, then the home agent folder. */
export function overrideFile(): string {
	return process.env[OVERRIDE_ENV] || path.join(getAgentDir(), "permissions.table.json");
}

/** The overlay path: the test hook first, then the home agent folder. */
export function overlayFile(): string {
	return process.env[OVERLAY_ENV] || path.join(getAgentDir(), "permissions.json");
}

/**
 * True when `file` sits in a git work tree, found by a `.git` marker in the file
 * folder or any folder above it. A marker is a directory or a file, so a linked
 * worktree counts.
 */
export function isInsideRepository(file: string): boolean {
	let dir = path.dirname(path.resolve(file));
	for (;;) {
		if (fs.existsSync(path.join(dir, ".git"))) return true;
		const parent = path.dirname(dir);
		if (parent === dir) return false;
		dir = parent;
	}
}

/** The top-level shape of a permission JSON file: one object. */
export type JsonDocument = Record<string, unknown>;

function fault(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Read one JSON file and parse it at the boundary into a named object type. */
function readJson(file: string): JsonDocument {
	let text: string;
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch (error) {
		throw new Error(`cannot read the file (${fault(error)})`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text) as unknown;
	} catch (error) {
		throw new Error(`invalid JSON (${fault(error)})`);
	}
	return asRecord(parsed, "the document");
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${what} must be a JSON object`);
	}
	return value as Record<string, unknown>;
}

function rejectUnknownKeys(
	doc: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	what: string,
): void {
	for (const key of Object.keys(doc)) {
		if (!allowed.has(key)) throw new Error(`${what} carries an unknown field "${key}"`);
	}
}

const TABLE_KEYS = new Set(["version", "rows"]);
const OVERRIDE_KEYS = new Set(["version", "patch"]);
const ENTRY_KEYS = new Set(["id", "verdict", "disabled", "row"]);

/**
 * Read and validate the shipped default file or one test fixture. Every row gets
 * the `default` layer.
 */
export function loadTableFile(file: string = DEFAULT_TABLE_FILE): RuleRow[] {
	const doc = readJson(file);
	rejectUnknownKeys(doc, TABLE_KEYS, "the table document");
	if (doc.version !== 1) throw new Error(`unsupported version ${JSON.stringify(doc.version)}`);
	if (!Array.isArray(doc.rows)) throw new Error(`"rows" must be a list`);
	if (doc.rows.length === 0) throw new Error(`"rows" must not be empty`);
	// SAFETY: the JSON rows carry no declared type. validateRows reads every
	// field as unknown and refuses anything outside the row schema.
	const rows = doc.rows as RuleRow[];
	validateRows(rows);
	return rows.map((row) => ({ ...row, layer: "default" as const }));
}

/** The shipped default rows, each stamped with the `default` layer. */
export function loadDefaultRows(): RuleRow[] {
	return loadTableFile(DEFAULT_TABLE_FILE);
}

/** The sorted class union of every row one id carries. */
function idClassList(rows: RuleRow[], indices: number[]): string {
	const classes = new Set<string>();
	for (const index of indices) for (const cls of rows[index].classes) classes.add(cls);
	return [...classes].sort().join(",");
}

/** Replace every row of one id with a complete supplied row, or add the row. */
function replaceRow(rows: RuleRow[], id: string, indices: number[], raw: unknown): RuleRow[] {
	const supplied = asRecord(raw, "the supplied row");
	if (supplied.id !== id) {
		throw rowFault(id, `the supplied row names "${String(supplied.id)}"`);
	}
	// SAFETY: a patch row arrives as JSON with no declared type. validateRow
	// reads every field as unknown and refuses anything outside the row schema,
	// so the cast only gives the validator a typed argument.
	const row = { ...(supplied as unknown as RuleRow), layer: "override" as const };
	validateRow(row);
	if (indices.length > 0) {
		const before = idClassList(rows, indices);
		const after = [...new Set(row.classes)].sort().join(",");
		if (before !== after) {
			throw rowFault(id, `a replacement must keep the class list (${before} to ${after})`);
		}
	}
	if (indices.length === 0) return [...rows, row];
	const first = indices[0];
	const next: RuleRow[] = [];
	rows.forEach((item, index) => {
		if (!indices.includes(index)) next.push(item);
		else if (index === first) next.push(row);
	});
	return next;
}

/** Apply one patch entry. A bad entry throws, and the whole override layer fails. */
function applyEntry(rows: RuleRow[], raw: unknown): RuleRow[] {
	const entry = asRecord(raw, "a patch entry");
	const id = typeof entry.id === "string" ? entry.id : undefined;
	for (const key of Object.keys(entry)) {
		if (!ENTRY_KEYS.has(key)) throw rowFault(id, `unknown field "${key}"`);
	}
	if (id === undefined || id.length === 0) throw rowFault(undefined, "an entry needs a string id");

	const actions = ["verdict", "disabled", "row"].filter((key) => entry[key] !== undefined);
	if (actions.length !== 1) {
		throw rowFault(
			id,
			"an entry does one of: change the verdict, disable the row, or supply a complete row",
		);
	}

	const indices: number[] = [];
	rows.forEach((row, index) => {
		if (row.id === id) indices.push(index);
	});

	if (actions[0] === "row") return replaceRow(rows, id, indices, entry.row);
	if (indices.length === 0) throw rowFault(id, "unknown row id");
	if (actions[0] === "disabled") {
		if (entry.disabled !== true) throw rowFault(id, `"disabled" must be true`);
		return rows.filter((_row, index) => !indices.includes(index));
	}
	// The verdict value is checked by the final `validateRows`, which names the id.
	const verdict = entry.verdict as Verdict;
	return rows.map((row, index) =>
		indices.includes(index) ? { ...row, verdict, layer: "override" as const } : row,
	);
}

/**
 * Read and validate the override file, then patch the rows by row id. A patch
 * entry changes the verdict of every row of that id, disables every row of that
 * id, or supplies a complete row. A supplied id that is absent adds one row; a
 * supplied id that is present replaces every row of that id.
 */
export function applyOverrideFile(rows: readonly RuleRow[], file: string): RuleRow[] {
	const doc = readJson(file);
	rejectUnknownKeys(doc, OVERRIDE_KEYS, "the override document");
	if (doc.version !== 1) throw new Error(`unsupported version ${JSON.stringify(doc.version)}`);
	if (!Array.isArray(doc.patch)) throw new Error(`"patch" must be a list`);
	let next = rows.map((row) => ({ ...row }));
	for (const entry of doc.patch) next = applyEntry(next, entry);
	validateRows(next);
	return next;
}

const OVERLAY_KEYS = new Set(["tool", "match", "reason"]);

/** Throw when the pattern does not compile, so a bad regex fences at load time. */
function assertRegex(match: string, where: string): void {
	try {
		compileRegex(match);
	} catch (error) {
		throw new Error(`${where} needs a valid "match" regex (${fault(error)})`);
	}
}

/**
 * One overlay row. The compiler drops a rule with no usable `match`, so a bad row
 * must throw here and close the gate instead.
 */
function validateOverlayRule(entry: unknown, where: string): RawRule {
	const row = asRecord(entry, where);
	rejectUnknownKeys(row, OVERLAY_KEYS, where);
	const { match, tool, reason } = row;
	if (typeof match !== "string" || match.length === 0) {
		throw new Error(`${where} needs a non-empty string "match"`);
	}
	assertRegex(match, where);
	if (tool !== undefined && (typeof tool !== "string" || tool.length === 0)) {
		throw new Error(`${where} needs a non-empty string "tool" when present`);
	}
	if (reason !== undefined && typeof reason !== "string") {
		throw new Error(`${where} needs a string "reason" when present`);
	}
	const rule: RawRule = { match };
	if (tool !== undefined) rule.tool = tool;
	if (reason !== undefined) rule.reason = reason;
	return rule;
}

/** One overlay section. An absent section is empty; a present one must be valid. */
function overlaySection(value: unknown, field: string): RawRule[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`"${field}" must be a list`);
	return value.map((entry, index) => validateOverlayRule(entry, `${field}[${index}]`));
}

/**
 * Read the live global permission file.
 *
 * The error must never be swallowed: the global deny and ask rules are the hard
 * floor under every agent, so an empty set would drop the secret, disk, and
 * release guards without a word. One line names the file and the fault, and the
 * returned rule set denies every tool call, so the fence stays closed.
 * A rule with no `tool` matches every tool, and `.*` matches any probe.
 */
export function loadGlobalRules(file: string = overlayFile()): OverlayRules {
	try {
		const cfg = asRecord(JSON.parse(fs.readFileSync(file, "utf-8")), "the global file");
		const stamp = (rules: RawRule[]): RawRule[] =>
			rules.map((rule) => ({ ...rule, layer: "overlay" as const }));
		return {
			deny: stamp(overlaySection(cfg.deny, "deny")),
			ask: stamp(overlaySection(cfg.ask, "ask")),
		};
	} catch (error) {
		const problem = fault(error);
		recordLogLine({
			text: `permission gate: cannot load ${file}: ${problem}; every tool call is denied until the file is fixed`,
		});
		return {
			deny: [
				{
					match: ".*",
					reason: "The global permissions file is unreadable, so every call is denied",
					layer: "overlay",
				},
			],
			ask: [],
		};
	}
}

function reportFailure(file: string, kind: PathKind, error: unknown): string {
	const line = `permission gate: cannot load the ${kind} file ${file}: ${fault(error)}; every tool call is denied until the file is fixed`;
	recordLogLine({ text: line });
	return line;
}

function reportRefusal(file: string, why: string): void {
	recordLogLine({
		text: `permission gate: refused ${file}: ${why}, so the shipped default stays in force`,
	});
}

/** The real path of a file that exists, or a refusal line and `null`. */
function resolveRealPath(file: string, what: string): string | null {
	try {
		return fs.realpathSync(file);
	} catch (error) {
		reportRefusal(file, `the ${what} real path cannot be resolved (${fault(error)})`);
		return null;
	}
}

/** The two configured layer kinds, named in every failure and refusal line. */
type PathKind = "table" | "override";

/**
 * One rule for both configured layers: the path is absolute, its real path is
 * checked, and a path inside a repository is refused. An absent or refused path
 * yields `fallback`. An absent override file applies no patch, so it needs no
 * refusal line; a table path has no such check.
 */
function resolvePermissionPath<F extends string | null>(
	configured: string | undefined,
	kind: PathKind,
	fallback: F,
): string | F {
	const raw = configured ?? (kind === "table" ? tableFile() : overrideFile());
	if (!path.isAbsolute(raw)) {
		reportRefusal(raw, `the ${kind} path must be absolute`);
		return fallback;
	}
	const wanted = path.resolve(raw);
	// The shipped default is the fallback, so it needs no real path check.
	if (kind === "table" && wanted === path.resolve(DEFAULT_TABLE_FILE)) return wanted;
	if (kind === "override" && !fs.existsSync(wanted)) return fallback;
	const real = resolveRealPath(wanted, kind);
	if (real === null) return fallback;
	if (isInsideRepository(real)) {
		reportRefusal(real, "a permission file inside a repository is ignored");
		return fallback;
	}
	return real;
}

function resolveTablePath(configured: string | undefined): string {
	return resolvePermissionPath(configured, "table", DEFAULT_TABLE_FILE);
}

function resolveOverridePath(configured: string | undefined): string | null {
	return resolvePermissionPath(configured, "override", null);
}

/**
 * Load the three layers in order and return the merged rows, the overlay, and
 * every failure line. Any table-layer failure empties the rows and adds a
 * deny-all fence to the overlay.
 */
export function loadPermissionConfig(paths: ConfigPaths = {}): PermissionConfig {
	const errors: string[] = [];

	const tablePath = resolveTablePath(paths.table);
	let rows: RuleRow[] = [];
	try {
		rows = loadTableFile(tablePath);
	} catch (error) {
		errors.push(reportFailure(tablePath, "table", error));
	}

	const overridePath = errors.length === 0 ? resolveOverridePath(paths.override) : null;
	if (overridePath !== null) {
		try {
			rows = applyOverrideFile(rows, overridePath);
		} catch (error) {
			errors.push(reportFailure(overridePath, "override", error));
		}
	}

	const overlay = loadGlobalRules(paths.overlay ?? overlayFile());
	if (errors.length > 0) {
		rows = [];
		overlay.deny = [...overlay.deny, { match: ".*", reason: FENCE_REASON, layer: "overlay" }];
	}
	return { rows, overlay, errors };
}
