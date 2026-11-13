/**
 * The row vocabulary and the row validation for the pi permission rule table.
 *
 * The table data (`platforms/pi/permissions.table.json`) holds one row per rule
 * and per class. `permission-config.ts` loads it, applies the user override, and
 * stamps every row with the layer it came from.
 *
 * The file has two duties. The first is the closed row vocabulary: the row type,
 * the row fields, the field sets, and the flag classes. The second is the row
 * schema check, so a form the vocabulary cannot express fails the load instead
 * of becoming a local exception here. `validateRows` refuses a row that breaks
 * the schema, and the message names the row id.
 *
 * The pattern builder lives in `permission-table-pattern.ts`. The grouping, the
 * counts, and the class compile live in `permission-table-groups.ts`.
 */

import type { Layer } from "./command-segments.ts";
import {
	PERMISSION_CLASSES,
	ROLE_CLASS,
	isPermissionClass,
	isRole,
	type PermissionClass,
	type Role,
} from "./permission-class.ts";

export type { Layer };

export type Verdict = "allow" | "ask" | "deny";

/**
 * A headless token shape. The row names the construct, not a verb: a stream
 * write (`>` or `tee`) and a shell function definition have no leading word.
 */
export type Probe = "stream-write" | "function-def";

/** A path zone. `secret` needs a family word in `verb`. */
export type Zone =
	| "cwd"
	| "notes:own"
	| "notes:all"
	| "tmp"
	| "any"
	| "secret"
	| "escape"
	| "path:ask";

/** The option class a row accepts. */
export type FlagClass =
	| "none"
	| "listed"
	| "any"
	| "dir-option"
	| "exec"
	| "recursive"
	| "force"
	| "delete"
	| "amend"
	| "strategy"
	| "upload-pack"
	| "inplace"
	| "disk-write"
	| "diff-write"
	| "rg-exec"
	| "clock"
	| "fs"
	| "refspec"
	| "prefixed"
	| "exception"
	| "bare"
	| "named"
	| "branch-read"
	| "subshell"
	| "process-sub";

/** What may follow the matched head: nothing, a path zone, or any words. */
export type Arg = "none" | "path" | "any";

export interface RuleRow {
	/** Stable rule name, shared by every class that gets the rule. */
	id: string;
	/** One or more tool names, space separated: `"read find ls grep"`. */
	tool: string;
	verdict: Verdict;
	/** The classes that get this row. All three means a global row. */
	classes: PermissionClass[];
	/**
	 * Professions that narrow a class-scoped row. A named profession must belong
	 * to one of `classes`. Only a named profession gets the row in
	 * `compileRole`; every other profession falls through to its own rule.
	 */
	roles?: Role[];
	/**
	 * Also select this `roles` row in `compileClass`, so an unnamed agent of the
	 * class gets it. The value must be `true`: an explicit `false` fails the table
	 * check, so omit the field to leave the row out.
	 */
	unnamed?: boolean;
	/** Leading literal words of the command, or the secret family of a path row. */
	verb?: string[];
	/** Literal words that follow the head, joined in order. */
	sub?: string[];
	flags?: FlagClass;
	zone?: Zone;
	/** A token shape with no leading word; only a deny row carries one. */
	probe?: Probe;
	arg: Arg;
	/**
	 * An ask row may match across a separator; it keeps the wide probe. The
	 * compiler refuses an ask row with `flags: "any"` and no `span`.
	 */
	span?: boolean;
	/**
	 * Withhold the leading `cd <dir> &&` fold. A verification or build command
	 * runs in the session directory, so a moved command falls to the mode default.
	 */
	noCd?: boolean;
	/** The sentence the prompt shows. It is never a pattern. */
	reason: string;
	/**
	 * The configuration layer that produced this row. `permission-config.ts`
	 * stamps it; the shipped default file never carries one. It is reported, not
	 * matched, so it never joins a pattern or the geometry check.
	 */
	layer?: Layer;
}

/**
 * The agent-notes segment of each role's write zone. `null` means the role has
 * no notes zone: the orchestrator writes the whole tree through `notes:all`,
 * and the mascot writes nothing. A role missing from this map fails the load.
 */
export const ROLE_NOTES: Record<Role, readonly string[] | null> = {
	orchestrator: null,
	planner: ["planner", "project-notes"],
	reviewer: ["reviewer"],
	researcher: ["researcher"],
	mascot: null,
	implementer: ["implementer"],
	tester: ["tester"],
};

const ROW_FIELDS = new Set<string>([
	"id",
	"tool",
	"verdict",
	"classes",
	"roles",
	"unnamed",
	"verb",
	"sub",
	"flags",
	"zone",
	"probe",
	"arg",
	"span",
	"noCd",
	"reason",
	"layer",
]);

const VERDICTS = new Set<string>(["allow", "ask", "deny"]);
const ARGS = new Set<string>(["none", "path", "any"]);
const ZONES = new Set<string>([
	"cwd",
	"notes:own",
	"notes:all",
	"tmp",
	"any",
	"secret",
	"escape",
	"path:ask",
]);
const FLAGS = new Set<string>([
	"none",
	"listed",
	"any",
	"dir-option",
	"exec",
	"recursive",
	"force",
	"delete",
	"amend",
	"strategy",
	"upload-pack",
	"inplace",
	"disk-write",
	"diff-write",
	"rg-exec",
	"clock",
	"fs",
	"refspec",
	"prefixed",
	"exception",
	"bare",
	"named",
	"branch-read",
	"subshell",
	"process-sub",
]);

/** The flag classes the compiler accepts. The test proves each one is used. */
export const FLAG_CLASSES: readonly string[] = [...FLAGS];

/**
 * Flag classes that only the exception composition uses. No row carries one:
 * force is a tag form, strategy is a merge, pull, or rebase form, and both the
 * amend form and the upload-pack form are bound in `EXCEPTION_BY_VERB`.
 */
export const TAIL_ONLY_CLASSES: readonly string[] = ["amend", "force", "strategy", "upload-pack"];
const PROBES = new Set<string>(["stream-write", "function-def"]);
const LAYERS = new Set<string>(["default", "override", "overlay"]);
const SECRET_FAMILIES = new Set<string>(["env", "key"]);

/**
 * A geometry field must be a plain word. A regex character would make the row a
 * pattern, which the table forbids; the compiler escapes every literal itself,
 * so a dot is data (a commit-message word, a pathspec) and is escaped, never a
 * pattern.
 */
const FORBIDDEN_CHAR = /[\\()[\]{}|*+?^$]/;

const ID_SHAPE = /^[a-z][a-z0-9.-]*$/;

/** A tool name is one plain token: a namespaced tool is never gated. */
const TOOL_SHAPE = /^[a-z][a-z0-9_]*$/;

// --- row validation ---------------------------------------------------------

/** The one row-fault error, so both layers write one prefix and one format. */
export function rowFault(id: string | undefined, problem: string): Error {
	const blank = id == null || (typeof id === "string" && id.trim().length === 0);
	return new Error(`row "${blank ? "<missing>" : String(id)}": ${problem}`);
}

/**
 * Throw the one row-fault error. The pattern module and the grouping module
 * import this helper, so every refusal carries the same prefix.
 */
export function fail(id: string | undefined, problem: string): never {
	throw rowFault(id, problem);
}

function oneLine(value: string): boolean {
	return value.length > 0 && !value.includes("\n") && !value.includes("\r");
}

function checkLiterals(id: string, field: string, words: unknown): void {
	if (!Array.isArray(words) || words.length === 0) {
		fail(id, `"${field}" must be a non-empty list of literal words`);
	}
	for (const word of words) {
		if (typeof word !== "string" || word.length === 0) {
			fail(id, `"${field}" must hold non-empty strings`);
		}
		if (FORBIDDEN_CHAR.test(word)) {
			fail(id, `"${field}" holds a forbidden regex character in "${word}"`);
		}
	}
}

/**
 * A tool-name allow row: no command match, no path zone, no probe shape. The
 * schema admits a global allow row only in this shape, because the engine has
 * no global allow set and the row is copied into every class's `agentAllow`.
 */
function isToolAllow(row: RuleRow): boolean {
	return (
		row.arg === "none" &&
		row.verb === undefined &&
		row.sub === undefined &&
		row.flags === undefined &&
		row.zone === undefined &&
		row.probe === undefined &&
		row.span === undefined &&
		row.noCd === undefined
	);
}

/** Validate one row. The message names the row id on every failure. */
export function validateRow(row: RuleRow): void {
	// SAFETY: a row arrives from a plain data module, so a stray key is possible
	// even though RuleRow does not declare it. Reading keys through this view is
	// the only way to name the offending field in the error.
	const record = row as unknown as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!ROW_FIELDS.has(key)) fail(row?.id, `unknown field "${key}"`);
	}
	if (typeof row.id !== "string" || !ID_SHAPE.test(row.id)) {
		fail(row.id, "id must be lower-case, dot-separated, and carry no regex character");
	}
	if (typeof row.tool !== "string" || row.tool.trim().length === 0) {
		fail(row.id, "tool is required");
	}
	for (const tool of row.tool.trim().split(/\s+/)) {
		if (!TOOL_SHAPE.test(tool)) {
			fail(row.id, `tool "${tool}" must be a plain lower-case name`);
		}
	}
	if (!VERDICTS.has(row.verdict)) fail(row.id, `unknown verdict "${String(row.verdict)}"`);
	if (!Array.isArray(row.classes) || row.classes.length === 0) {
		fail(row.id, "classes must name at least one class");
	}
	for (const cls of row.classes) {
		if (!isPermissionClass(cls)) fail(row.id, `unknown class "${String(cls)}"`);
	}
	if (row.roles !== undefined) {
		if (!Array.isArray(row.roles) || row.roles.length === 0) {
			fail(row.id, "roles must name at least one profession");
		}
		const named = new Set<string>();
		for (const role of row.roles) {
			if (!isRole(role)) fail(row.id, `unknown profession "${String(role)}"`);
			if (!row.classes.includes(ROLE_CLASS[role])) {
				fail(row.id, `profession "${role}" is outside the row's classes`);
			}
			if (named.has(role)) fail(row.id, `profession "${role}" is named twice`);
			named.add(role);
		}
	}
	if (row.unnamed !== undefined) {
		if (typeof row.unnamed !== "boolean") fail(row.id, "unnamed must be a boolean");
		if (row.unnamed === false) fail(row.id, "unnamed widens a row only, so omit a false value");
		if (row.roles === undefined) fail(row.id, "unnamed widens a roles row, so the row must name roles");
	}
	if (PERMISSION_CLASSES.every((cls) => row.classes.includes(cls)) && row.verdict === "allow" && !isToolAllow(row)) {
		fail(row.id, "a global allow row must name tools only and carry no command geometry");
	}
	if (!ARGS.has(row.arg)) fail(row.id, `unknown arg "${String(row.arg)}"`);
	if (row.flags !== undefined && !FLAGS.has(row.flags)) {
		fail(row.id, `unknown flag class "${String(row.flags)}"`);
	}
	if (row.zone !== undefined && !ZONES.has(row.zone)) {
		fail(row.id, `unknown zone "${String(row.zone)}"`);
	}
	if (typeof row.reason !== "string" || !oneLine(row.reason)) {
		fail(row.id, "reason is required and must be one line");
	}
	if (row.reason.includes("\\")) {
		fail(row.id, "reason carries a regex escape; the prompt shows the reason, never a pattern");
	}
	if (row.span !== undefined && typeof row.span !== "boolean") {
		fail(row.id, "span must be a boolean");
	}
	if (row.noCd !== undefined && typeof row.noCd !== "boolean") {
		fail(row.id, "noCd must be a boolean");
	}
	if (row.layer !== undefined && !LAYERS.has(row.layer)) {
		fail(row.id, `unknown layer "${String(row.layer)}"`);
	}
	if (row.verb !== undefined) checkLiterals(row.id, "verb", row.verb);
	if (row.sub !== undefined) checkLiterals(row.id, "sub", row.sub);

	if (row.probe !== undefined) {
		if (!PROBES.has(row.probe)) fail(row.id, `unknown probe "${String(row.probe)}"`);
		if (row.verdict !== "deny") fail(row.id, "a probe row must be a deny row");
		if (row.arg !== "any") fail(row.id, "a probe row takes no argument shape");
		if (row.zone !== undefined) fail(row.id, "a probe row carries no zone");
		if (row.verb !== undefined) fail(row.id, "a probe row carries no verb");
		if (row.sub !== undefined) fail(row.id, "a probe row carries no subcommand");
		if (row.flags !== undefined) fail(row.id, "a probe row carries no flag class");
		if (row.span !== undefined) fail(row.id, "a probe row carries no span");
		return;
	}
	if (row.arg === "path") {
		if (row.zone === undefined) fail(row.id, "a path row needs a zone");
		if (row.verb !== undefined && row.zone === "secret") {
			for (const family of row.verb) {
				if (!SECRET_FAMILIES.has(family)) {
					fail(row.id, `unknown secret family "${family}"`);
				}
			}
		}
		return;
	}
	if (row.zone !== undefined) fail(row.id, "only a path row carries a zone");
	// The fifth refusal: an ask row that accepts any option and does not span is
	// too wide to show as one prompt.
	if (row.verdict === "ask" && row.flags === "any" && row.span !== true) {
		fail(row.id, "an ask row with flags \"any\" must set span");
	}
	if (row.arg === "none") return;
	if (row.verb === undefined) fail(row.id, "a command row needs a verb");
	if (row.tool.split(/\s+/).includes("bash") && row.verb.length === 0) {
		fail(row.id, "a bash row needs a non-empty verb");
	}
}

function geometry(row: RuleRow): string {
	// `roles` and `unnamed` stay out: two class rows of one id narrow to different
	// professions, so a roles comparison would refuse the pair.
	return JSON.stringify({
		tool: row.tool,
		verdict: row.verdict,
		verb: row.verb ?? null,
		sub: row.sub ?? null,
		flags: row.flags ?? "none",
		zone: row.zone ?? null,
		probe: row.probe ?? null,
		arg: row.arg,
		span: row.span ?? false,
		noCd: row.noCd ?? false,
		reason: row.reason,
	});
}

/**
 * Validate every row and every duplicate. One id may appear in more than one
 * class, but the verdict and the geometry must agree; two rows with one id and
 * two verdicts, or two geometries, fail the load.
 */
export function validateRows(rows: readonly RuleRow[]): void {
	const seen = new Map<string, RuleRow>();
	for (const row of rows) {
		validateRow(row);
		const first = seen.get(row.id);
		if (!first) {
			seen.set(row.id, row);
			continue;
		}
		if (first.verdict !== row.verdict) {
			fail(row.id, `duplicate id with a conflicting verdict (${first.verdict} and ${row.verdict})`);
		}
		if (geometry(first) !== geometry(row)) {
			fail(row.id, "duplicate id with conflicting geometry");
		}
	}
}
