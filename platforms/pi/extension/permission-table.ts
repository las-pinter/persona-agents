/**
 * Compiler for the pi permission rule table.
 *
 * The table data (`platforms/pi/permissions.table.json`) holds one row per rule
 * and per class. `permission-config.ts` loads it, applies the user override, and
 * stamps every row with the layer it came from. This module turns a row into an
 * anchored, case-insensitive pattern and
 * groups the rows into the five rule sets the engine already consumes
 * (`RuleSets` in `command-segments.ts`). The engine is not changed here: the
 * shapes below are the shapes it reads today.
 *
 * The file has one duty: the table compiler. Validation, pattern construction,
 * and grouping share one closed vocabulary of row fields, flag classes, and
 * pattern pieces, so a split would copy that vocabulary into every part.
 *
 * A row carries no pattern. Every pattern piece comes from this module:
 *
 *   - the wrapper column of a deny or ask row (`env`, `timeout`, `sudo`, ...),
 *   - the leading `cd <dir> &&` fold of a bash row, unless the row sets `noCd`,
 *   - the git global-option slot, named by a flag class,
 *   - the option tail of a flag class (`-exec`, `-i`, `--output`, ...),
 *   - the named-form guard that keeps a recursive removal out of an ask row,
 *   - the path zone of a read, edit, or write row,
 *   - the probe shape of a stream write or a shell function definition,
 *   - the exception tail of `git.history.exception`,
 *   - the prefix forms of `git.history.prefixed`.
 *
 * A row is scoped to a class, and a class holds more than one profession. A row
 * that carries `roles` applies only to the professions it names, so
 * `compileRole` selects it for a named profession. `compileClass` drops the row,
 * because a class carries no profession name, so an unnamed agent falls to the
 * mode default. A `roles` row that sets `unnamed` is the exception: it joins its
 * class compile, so an unnamed agent of that class gets the row.
 *
 * A form the row vocabulary cannot express is a schema change, not a local
 * exception here. `validateRows` refuses a row that breaks the schema, and the
 * message names the row id.
 *
 * Rule groups. A row with all three classes is a global row and goes into
 * `globalDeny` or `globalAsk`. A row with one class goes into `agentDeny`,
 * `agentAsk`, or `agentAllow` for that class. The engine has no global allow
 * set, so a global allow row is refused unless it names tools only: such a row
 * carries no command geometry and is copied into `agentAllow` for every class.
 * A command allow row would widen every class at once, so the schema refuses it.
 * A row with `roles` keeps its class group and narrows per profession in
 * `compileRole`.
 *
 * Write zones. A zone is one role: `roleZone` holds a role name, and the zone
 * segments are read from `ROLE_NOTES` inside this module. So no function here
 * can bind a zone to more than one role. `compileRole` binds the role's own
 * zone. `compileClass` is not a role, so it binds no zone: a `notes:own` row
 * matches nothing there, and an unbound `path:ask` row keeps its generic
 * pattern. The gate compiles per role with `compileRole`.
 */

import type { Layer, RawRule, RuleSets } from "./command-segments.ts";
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

// --- shared pattern pieces ---------------------------------------------------

/** A deny or ask row starts at a command position, not inside a word. */
const SEP_START = "(?:^|[;&|(\\n])\\s*";
const ANCHOR = "^";

/**
 * The wrapper column: a command prefix that runs another command
 * (`env FOO=1`, `time`, `nice`, `nohup`, `exec`, `command`, `sudo`, `timeout
 * 5s`, `chrt -f 10`) or a leading assignment. It is part of every deny and ask
 * pattern, never of an allow pattern. `WRAP` accepts no wrapper, and `WRAP_ONE`
 * requires at least one.
 */
const WRAP_ATOM =
	"(?:env|time|nice|nohup|exec|command|sudo)(?:\\s+-\\S+(?:\\s+[^-\\s]\\S*)?)*\\s+" +
	"|(?:timeout|chrt)(?:\\s+-\\S+(?:\\s+[^-\\s]\\S*)?)*\\s+\\S+\\s+" +
	"|[A-Za-z_][A-Za-z0-9_]*=\\S+\\s+";
const WRAP = `(?:${WRAP_ATOM})*`;
const WRAP_ONE = `(?:${WRAP_ATOM})+`;

/** A leading `cd <dir> &&` fold. The parser folds the same form. */
const CD = "(?:cd\\s+\\S+\\s*&&\\s*)?";

/**
 * A git config key, not a directory. Only the exception scan reads it now; the
 * path slot reads the path grammar below. A value that ends in `.git` is a bare
 * repository directory, so it stays a path.
 */
const CONFIG_KEY = "(?!\\S*\\.git(?:\\s|$))[A-Za-z][A-Za-z0-9-]*\\.[^\\s/]*";

/**
 * The path grammar of the git directory option. A value is a path only when it
 * holds no single quote, no double quote, and no backslash; it holds a slash or
 * it ends in `.git`; and, when it holds an equals sign, it starts with `/`,
 * `./`, `../`, or the home marker `~`. Every other value is not a path, and the
 * `git.dir-option.ask` row covers it.
 */
const PATH_CHAR = `[^\\s'"\\\\]`;
export const PATH_VALUE =
	`(?=${PATH_CHAR}*(?:/|\\.git(?=\\s|$)))` +
	`(?:[^\\s'"\\\\=]+|(?:/|\\./|\\.\\./|~)${PATH_CHAR}*)(?=\\s|$)`;

/** True when one value satisfies the directory-option path grammar. */
export function isPathValue(value: string): boolean {
	return new RegExp(`^${PATH_VALUE}$`).test(value);
}

/**
 * The git global-option columns. A `-C` value must satisfy the path grammar:
 * the engine matches case-insensitively, so `-c` and `-C` are one token and a
 * config key would otherwise ride the path slot.
 *   listed: the three options a history command may carry, with a path value.
 *   any:    any option, for the deny rows and the exception ask row.
 */
const OPT = {
	listed: `(?:\\s+(?:-C\\s+${PATH_VALUE}|--no-pager|-p))*`,
	any: "(?:\\s+(?:-C\\s+\\S+|--?[A-Za-z][A-Za-z0-9-]*(?:=\\S+)?))*",
} as const;

/**
 * One git global option, listed or not. The three listed options are the only
 * ones a plain history command may carry.
 */
const ANY_OPT = "(?:-C\\s+\\S+|--no-pager|-p|--?[A-Za-z][A-Za-z0-9-]*(?:=\\S+)?)";

/**
 * A git global option outside the listed three. It can change what the history
 * command runs (`--git-dir`, `--exec-path`, an option git adds later). A `-C
 * <path>` stays one of the listed options, so every path form allows. The config
 * override is the `-c <key>=<value>` form, and `EXCEPTION_ANY` names it.
 */
const UNLISTED_OPT =
	"(?!(?:-C\\s|--no-pager(?=\\s|$)|-p(?=\\s|$)))--?[A-Za-z][A-Za-z0-9-]*(?:=\\S+)?";

/**
 * The option ladders. This is the only place a ladder is written. A row, a tail,
 * and the exception forms all read these constants, so one abbreviation ladder
 * cannot drift from a copy written somewhere else.
 */
export const LADDER = {
	amend: "--a(?:m[a-z]*)?",
	delete: "--d(?:e(?:l(?:e(?:t(?:e)?)?)?)?)?",
	force: "--f(?:o(?:r(?:c(?:e)?)?)?)?",
	strategy: "--s(?:t(?:r(?:a(?:t(?:e(?:g(?:y)?)?)?)?)?)?)?",
	"upload-pack": "--upl[a-z-]*",
	inplace: "--i[a-z-]*",
	"rg-pre": "--pre",
	"rg-zip": "--search-zip",
	clock: "--s[a-z-]*",
	"diff-output": "--o(?:u(?:t(?:p(?:u(?:t)?)?)?)?)?",
	"diff-ext": "--e(?:x(?:t(?:-(?:d(?:i(?:f(?:f)?)?)?)?)?)?)?",
	"diff-textconv": "--t(?:e(?:x(?:t(?:c(?:o(?:n(?:v)?)?)?)?)?)?)?",
	"diff-filters": "--f(?:i(?:l(?:t(?:e(?:r(?:s)?)?)?)?)?)?",
	"branch-list":
		"-vv|-v|-l|--list|-a|-r|--show-current|--format(?:=\\S+)?|" +
		"--contains(?:=\\S+|\\s+\\S+)?|--no-contains(?:=\\S+|\\s+\\S+)?|" +
		"--merged(?:=\\S+|\\s+\\S+)?|--no-merged(?:=\\S+|\\s+\\S+)?|" +
		"--points-at(?:=\\S+|\\s+\\S+)?",
} as const;

/**
 * A scan that skips quoted words. The legacy exception rules use it, so a commit
 * message that holds a flag word or a leading dash never reaches a tail. It
 * stops at an unquoted separator.
 */
const SCAN = "(?:\\\\.|[^\\\\'\";&|\\n]|'[^']*'|\"(?:\\\\.|[^\"\\\\])*\")*?";

/**
 * A git directory option whose value is not a path. The engine matches
 * case-insensitively, so one ask row covers the `-C` and the `-c` spelling.
 */
const NON_PATH_DIR = `-[cC]\\s+(?!${PATH_VALUE})\\S`;

/**
 * Every recursive removal option: a short bundle that holds `r` or `R`, or the
 * long option. The recursive deny tail and the named-form guard read this one
 * piece, so the ask row can never own a form the deny row fences.
 */
const RECURSIVE_FLAG = "(?:-[A-Za-z]*r[A-Za-z]*|--recursive)(?=[\\s=]|$)";

/**
 * The option tail of each flag class. The tail is a lookahead, so the words
 * between the head and the flag stay outside the match.
 */
export const TAIL: Record<FlagClass, string | null> = {
	none: null,
	listed: null,
	any: null,
	"dir-option": NON_PATH_DIR,
	exception: null,
	fs: null,
	prefixed: null,
	bare: null,
	// A named-form row owns the plain form only, so it carries no tail; the
	// pattern builder appends its guard instead.
	named: null,
	"branch-read": null,
	subshell: null,
	"process-sub": null,
	exec: "(?:-exec|-execdir|-fls|-fprint(?:0|f)?|-ok|-okdir|-delete|--exec)(?=[\\s;|&()]|$)",
	recursive: RECURSIVE_FLAG,
	// A short bundle asks when it holds the force letter anywhere: tag accepts
	// `-fm` and `-mf`, so a trailing-only match leaves a force move open.
	force: `(?:-(?=[^-\\s])[^\\s=]*f[^\\s=]*|${LADDER.force})(?=[\\s=]|$)`,
	// A long delete option accepts every abbreviation, so `--del` counts.
	delete: `(?:-[A-Za-z0-9]*d[A-Za-z0-9]*|${LADDER.delete})(?=[\\s=]|$)`,
	amend: `${LADDER.amend}(?=[\\s=]|$)`,
	strategy: `(?:-[A-Za-z]*s|${LADDER.strategy})(?=[\\s=]|$)`,
	"upload-pack": `${LADDER["upload-pack"]}(?=[\\s=]|$)`,
	inplace: `(?:-[A-Za-z]*i[A-Za-z]*|${LADDER.inplace})(?=[\\s=.]|$)`,
	"disk-write": "of=/dev/",
	// The diff family writes a file under `--output` and runs a driver under the
	// other three options. Git accepts any unique prefix of a long option, so
	// each option is a ladder of its own letters.
	"diff-write":
		`(?:${LADDER["diff-output"]}|${LADDER["diff-ext"]}|` +
		`${LADDER["diff-textconv"]}|${LADDER["diff-filters"]})(?=[\\s=]|$)`,
	// `rg --pre` runs a program and `rg -z` runs a decompression program.
	"rg-exec": `(?:${LADDER["rg-pre"]}|-[A-Za-z]*z[A-Za-z]*|${LADDER["rg-zip"]})(?=[\\s=]|$)`,
	// `date -s` sets the system clock.
	clock: `(?:-s[A-Za-z]*|${LADDER.clock})(?=[\\s=]|$)`,
	// A refspec holds a `:` (`main:refs/heads/main`), and that colon is what
	// makes the fetch write a named ref instead of the configured refspecs.
	refspec: "[^\\n]*:",
};

/**
 * The headless token shapes. Each entry is a whole probe, so a match needs no
 * leading word and no anchor.
 */
const PROBE: Record<Probe, string> = {
	"stream-write": "(?:>>|>)(?!&\\d(?=$|[\\s;&|()<>]))|(?:^|[;&|(\\s])\\s*tee\\s+",
	"function-def": "(?:^|[;&|(\\n])\\s*(?:[A-Za-z0-9_-]+|:)\\s*\\(\\s*\\)\\s*\\{",
};

/**
 * The exception forms that are not bound to one verb: a `git -c` override, a
 * runtime-shaped word, and a glob or brace word. They scan the whole tail. The
 * engine matches case-insensitively, so the override form also covers a `-C`
 * whose value is a config key. The `git.dir-option.ask` row owns the wider
 * non-path values; this list keeps its own two key shapes.
 */
const EXCEPTION_ANY = [
	"\\s-c\\s+[A-Za-z_][A-Za-z0-9_.-]*=",
	`\\s-c\\s+${CONFIG_KEY}(?=\\s|$)`,
	"\\$",
	"`",
	"[*?\\[{]",
	"[!@+]\\(",
].join("|");

/**
 * The option forms bound to one history verb. Force is a tag form and strategy
 * is a merge, pull, or rebase form, so a commit or merge option that happens to
 * share letters (`--fixup`, `--squash`, `--no-ff`) never asks. The forms come
 * from `TAIL`, so each ladder still has one spelling. A transport helper URL
 * carries the double colon inside its own word (`ext::sh`), so the URL form is
 * any token that holds a double colon.
 */
const EXCEPTION_BY_VERB: Record<string, readonly string[]> = {
	add: [],
	commit: [TAIL.amend as string],
	merge: [TAIL.strategy as string, "\\S*::"],
	pull: [TAIL.strategy as string, TAIL["upload-pack"] as string, "\\S*::"],
	rebase: [TAIL.strategy as string],
	tag: [TAIL.force as string],
};

const SECRET: Record<string, string> = {
	env: "(^|/)[.][^/]*env[^/]*$|\\.envrc$",
	key: "id_rsa|id_ed25519|\\.pem$|(^|/)credentials$|\\.aws(/|$)|\\.ssh(/|$)",
};

// --- row validation ---------------------------------------------------------

function fail(id: string | undefined, problem: string): never {
	throw new Error(`permission-table: row "${id ?? "<missing>"}": ${problem}`);
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

// --- pattern construction ---------------------------------------------------

function escapeToken(token: string): string {
	return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A literal word or phrase. An internal space becomes one or more spaces. */
export function literal(word: string): string {
	return word
		.trim()
		.split(/\s+/)
		.map(escapeToken)
		.join("\\s+");
}

function alternation(words: readonly string[]): string {
	return words.map(literal).join("|");
}

/** The global-option slot a flag class opens before the subcommand. */
function optionSlot(flags: FlagClass | undefined): string {
	if (flags === "listed") return OPT.listed;
	if (flags === "any") return OPT.any;
	return "";
}

/**
 * The notes zone a role writes. A zone is one role name, and the compiler reads
 * that role's segments from `ROLE_NOTES` itself, so no caller can pass another
 * role's segments or a union of two roles.
 */
export interface NotesZone {
	readonly role: Role;
}

/** The zone of one role. An unknown role fails the load. */
export function roleZone(role: Role): NotesZone {
	if (!isRole(role)) fail("<role>", `unknown role "${String(role)}"`);
	return { role };
}

function zoneSegments(zone: NotesZone): readonly string[] | null {
	return ROLE_NOTES[zone.role];
}

function notesZones(zones: readonly string[] | null): string | null {
	if (!zones || zones.length === 0) return null;
	return `(?:${zones.map(escapeToken).join("|")})`;
}

/**
 * The path pattern of a zone. `notes:own` and `path:ask` take the resolved
 * notes zones of the role or class that owns the row.
 */
export function zonePattern(zone: Zone, family: string | undefined, notes: readonly string[] | null): string {
	const own = notesZones(notes);
	const noParent = "(?!(?:.*/)?\\.\\.(?:/|$))";
	switch (zone) {
		case "any":
			return ".";
		case "cwd":
			return `^(?![/~])${noParent}(?=.)`;
		case "tmp":
			return `^/${noParent}tmp(?:/|$)`;
		case "notes:own":
			return own ? `^(?!~)${noParent}(?:.*/)?agent-notes/${own}(?:/|$)` : "(?!)";
		case "notes:all":
			return `^(?!~)${noParent}(?:.*/)?agent-notes(?:/|$)`;
		case "escape":
			return `(?:^|/)\\.\\.(?:/|$)|^~`;
		case "path:ask": {
			const inside = own ? `agent-notes/${own}(?:/|$)|tmp(?:/|$)` : "agent-notes(?:/|$)|tmp(?:/|$)";
			return `(?:^|/)\\.\\.(?:/|$)|^~|^/${noParent}(?!.*(?:${inside}))`;
		}
		case "secret":
			return SECRET[family ?? ""] ?? fail("<secret>", "secret zone needs an env or key family");
		default:
			return fail("<zone>", `unknown zone "${String(zone)}"`);
	}
}

/** One pattern for one row. The pattern is built here, never in the table. */
export function patternFor(row: RuleRow, zone: NotesZone | null = null): string {
	if (row.arg === "path") {
		const notes = zone ? zoneSegments(zone) : null;
		return zonePattern(row.zone as Zone, row.verb?.[0], notes);
	}
	if (row.arg === "none") {
		return ".";
	}
	if (row.probe !== undefined) {
		return PROBE[row.probe] ?? fail(row.id, `unknown probe "${String(row.probe)}"`);
	}

	const start = row.verdict === "allow" ? ANCHOR : SEP_START;
	const wrap = row.verdict === "allow" ? "" : WRAP;
	// A verification or build row withholds the `cd` fold: a moved command must
	// fall to the mode default, as the retired anchored rules did.
	const cd = row.noCd ? "" : CD;
	const verbs = row.verb ?? [];
	// `mkfs.<fs>` carries a suffix, so the filesystem row accepts a dot too. A
	// `dd` row accepts the bare word and needs its device write in the tail.
	const headEnd = row.flags === "fs" ? "(?=[\\s.]|$)" : "(?=\\s|$)";
	const head = `(?:${alternation(verbs)})${headEnd}`;

	// The exception row reads the whole tail with a quoted-word scan. A form bound
	// to one verb is a branch of its own, so force stays a tag form and strategy
	// stays a merge, pull, or rebase form. The unbound forms scan the whole line.
	if (row.flags === "exception" && row.sub) {
		const bound = row.sub
			.map((verb) => {
				const flagTails = (EXCEPTION_BY_VERB[verb] ?? []).map((tail) => `\\s(?:${tail})`);
				const tails = [...flagTails, EXCEPTION_ANY].join("|");
				// The option region before the verb may hold a listed or an unlisted
				// global option, so `git -C /x commit --amend` asks like the legacy rule.
				return `(?=${OPT.any}\\s+${literal(verb)}(?=\\s|$)${SCAN}(?:${tails}))`;
			})
			.join("|");
		const any =
			`(?=${SCAN}(?:${EXCEPTION_ANY}))` +
			`(?=${SCAN}\\s(?:${alternation(row.sub)})(?=\\s|$))`;
		return `${start}${wrap}${cd}${head}(?:${bound}|${any})`;
	}

	// A history verb inside a substitution or a subshell is never a silent allow.
	if (row.flags === "subshell" && row.sub) {
		const sub = `(?:${alternation(row.sub)})(?=\\s|$)`;
		return "[(`]\\s*" + `${WRAP}${cd}${head}${OPT.any}\\s+${sub}`;
	}

	// A process substitution runs a command in the host shell.
	if (row.flags === "process-sub") {
		return `${start}${wrap}${cd}${head}(?=${SCAN}(?:[<=]\\())`;
	}

	// The prefix row names two forms: a wrapper prefix that runs the verb, and a
	// global option outside the listed three. The option branch keeps the option
	// region before the verb, so a flag inside the verb's own arguments (a commit
	// message word) never reaches it. An unlisted option may carry a separate
	// value word (`--work-tree /x`), because a plain option name is not a verb.
	if (row.flags === "prefixed" && row.sub) {
		const sub = `(?:${alternation(row.sub)})(?=\\s|$)`;
		const wrapped = `${start}${cd}(?:${WRAP_ONE})${cd}${head}${OPT.listed}\\s+${sub}`;
		const option =
			`${start}${cd}${wrap}${cd}${head}${OPT.listed}\\s+${UNLISTED_OPT}` +
			`(?:\\s+[^-\\s]\\S*)?(?:\\s+${ANY_OPT}(?:\\s+[^-\\s]\\S*)?)*\\s+${sub}`;
		return `(?:${wrapped}|${option})`;
	}

	// A git row accepts the three listed global options before its subcommand.
	const slot = optionSlot(row.flags) || (verbs.includes("git") ? OPT.listed : "");

	let body = head;
	if (row.sub) {
		const sep = row.span ? "[^\\n]*\\s" : "\\s+";
		body += `${slot}${sep}(?:${alternation(row.sub)})(?=\\s|$)`;
	}

	const tail = TAIL[row.flags ?? "none"];
	if (row.flags === "bare") {
		// The row ends at the matched words: a trailing argument is not covered.
		body += "(?=\\s*$)";
	} else if (row.flags === "branch-read") {
		// Only the listing option group may follow `branch`, and it must end the
		// segment, so a branch write form falls outside the row.
		body += `(?=(?:\\s+(?:${LADDER["branch-list"]}))*\\s*$)`;
	} else if (row.flags === "named") {
		// The `named` class name is historical: it owns the plain form, not a named flag.
		// A named-form row owns the plain form only. A recursive option in the same
		// segment makes the row match nothing, so the recursive deny row keeps that
		// form and the ask row never covers it. The scan skips quoted words, as the
		// recursive tail does, so a quoted separator cannot hide the flag.
		body += `(?!${SCAN}\\s${RECURSIVE_FLAG})`;
	} else if (tail) {
		// The tail is required for every flag class: a row that names an option
		// denies the option, never the bare command.
		body += `(?=${SCAN}\\s${tail})`;
	}
	return `${start}${wrap}${cd}${body}`;
}

/** Every engine rule a row produces: one per tool it names. */
export function rulesForRow(row: RuleRow, zone: NotesZone | null = null): RawRule[] {
	const match = patternFor(row, zone);
	return row.tool
		.trim()
		.split(/\s+/)
		.map((tool) => {
			const rule: RawRule = { tool, match, reason: row.reason };
			if (row.layer !== undefined) rule.layer = row.layer;
			return rule;
		});
}

// --- grouping ---------------------------------------------------------------

function isGlobal(row: RuleRow): boolean {
	return PERMISSION_CLASSES.every((cls) => row.classes.includes(cls));
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
