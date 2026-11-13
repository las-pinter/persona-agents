/**
 * The pattern builder for the pi permission rule table.
 *
 * The file has one duty: turn one row into an anchored, case-insensitive match
 * pattern. The shared pattern pieces come first, then the builder that composes
 * them for one row.
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
 * Write zones. A zone is one role: `roleZone` holds a role name, and the zone
 * segments are read from `ROLE_NOTES` in `permission-table.ts`. So no function
 * here can bind a zone to more than one role. `compileRole` binds the role's own
 * zone. `compileClass` is not a role, so it binds no zone: a `notes:own` row
 * matches nothing there, and an unbound `path:ask` row keeps its generic
 * pattern. The gate compiles per role with `compileRole`.
 */

import type { RawRule } from "./command-segments.ts";
import { isRole, type Role } from "./permission-class.ts";
import {
	ROLE_NOTES,
	fail,
	type FlagClass,
	type Probe,
	type RuleRow,
	type Zone,
} from "./permission-table.ts";

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
