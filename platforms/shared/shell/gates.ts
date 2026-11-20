/**
 * Shell gates: what one shell command touches, independent of any platform.
 *
 * One command is split into segments by the shell parser, each segment is
 * unwrapped (`cd x &&`, env/sudo/xargs/eval prefixes, `bash -c '...'`), and
 * classified into one of three gates:
 *
 *   history: a plain git add/commit/pull/merge/rebase/tag
 *   publish: git push, gh pr/release/run, a history command that is an ask
 *            exception, or any wrapped or runtime-shaped history command
 *   write:   a file-changing command or an output redirect to a file
 *
 * A segment no gate covers is `ungated`. A platform decides the verdict for
 * each hit: the Claude hook (`platforms/claude/scripts/doctrine.ts`) and the Pi
 * gate (`platforms/pi/scripts/policy.ts`) share this file, so one parser owns
 * every safety decision on both platforms.
 *
 * A command the parser cannot read (a heredoc, an unbalanced quote) that holds
 * a gated form counts as a hit: fail closed. Unreadable text with only git read
 * verbs (status, diff, log) is not a hit. One exception: a single quoted
 * heredoc fed to a data reader (cat, tee, python3 -, node -) is checked by its
 * header only (safeHeredocHeader).
 */

import { basename } from "node:path";
import { parseShellCommand } from "./shell-parse.ts";

export type Hit = "history" | "publish" | "write" | typeof UNGATED;
/** A segment that runs a command no gate covers. */
export const UNGATED = "ungated";

const GIT_HISTORY = new Set(["add", "commit", "pull", "merge", "rebase", "tag"]);
const GIT_PUBLISH = new Set(["push"]);
const GH_PUBLISH = new Set(["pr", "release", "run"]);
/**
 * The only git global options a history command may carry and still get its
 * verdict by subcommand. Any other leading option (-c, --config-env,
 * --exec-path, --attr-source, an option git adds later) makes the command
 * publish.
 */
const GIT_PLAIN_OPTIONS = new Set([
	"--no-pager", "-p", "--paginate", "-P", "--bare", "--no-replace-objects", "--literal-pathspecs",
	"--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--no-advice",
]);
/** Global options with a value, as the next token or after `=` (long forms). */
const GIT_PATH_OPTIONS = new Set(["-C", "--git-dir", "--work-tree", "--namespace"]);
/** Global options that only print and exit; the rest of the line is not run as a subcommand. */
const GIT_INFO_OPTIONS = new Set(["--version", "--help"]);

/** The git subcommand after its global options. */
export function gitSubcommand(args: string[]): { sub: string; rest: string[]; unknown: boolean } {
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) {
		const arg = args[i];
		if (GIT_INFO_OPTIONS.has(arg)) return { sub: "", rest: [], unknown: false };
		if (GIT_PLAIN_OPTIONS.has(arg)) i += 1;
		else if (GIT_PATH_OPTIONS.has(arg)) i += 2;
		else if (arg.startsWith("--") && GIT_PATH_OPTIONS.has(arg.split("=")[0])) i += 1;
		// An unknown option may take the next token, so the subcommand is unknown.
		else return { sub: "", rest: [], unknown: true };
	}
	return { sub: args[i] ?? "", rest: args.slice(i + 1), unknown: false };
}
/** `git tag` with only these options lists tags; anything else writes. */
const GIT_TAG_LIST_OPTIONS = new Set(["-l", "--list", "-n", "--contains", "--no-contains", "--points-at", "--merged", "--no-merged", "--sort", "--column", "--no-column"]);
/** Commands that change files. */
const WRITE_COMMANDS = new Set([
	"cp", "mv", "rsync", "rm", "rmdir", "tee", "dd", "truncate", "install", "ln", "mkdir", "touch",
	"chmod", "chown", "chgrp", "patch", "shred", "unlink", "scp", "curl", "wget",
]);
/** Commands that change files only with an in-place flag (`sed -i`, `perl -pi`). */
const IN_PLACE_COMMANDS = new Set(["sed", "perl", "ruby"]);
/** Git verbs that only read; any other verb is a write. */
const GIT_READ = new Set([
	"status", "diff", "log", "show", "blame", "rev-parse", "ls-files", "ls-tree", "grep", "describe",
	"shortlog", "cat-file", "merge-base", "rev-list", "show-ref", "reflog", "version", "help", "range-diff",
	"whatchanged", "name-rev", "for-each-ref", "check-ignore", "check-attr", "var",
]);
/** gh actions that only read (`gh issue list`, `gh repo view`). */
const GH_READ_ACTIONS = new Set(["list", "view", "status", "diff", "checks", "search"]);
const GH_READ_COMMANDS = new Set(["status", "search", "help", "version", "browse"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
/** Prefix commands that run the rest of the line, with options to skip. */
const PREFIX_COMMANDS = new Set(["!", "sudo", "env", "command", "nice", "nohup", "time", "exec", "xargs", "eval", "timeout", "stdbuf", "doas"]);
/** Prefix options that take the next token as their value. */
const PREFIX_VALUE_OPTIONS: Record<string, Set<string>> = {
	sudo: new Set(["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "--user", "--group", "--chdir"]),
	doas: new Set(["-u", "-C"]),
	env: new Set(["-u", "-C", "--unset", "--chdir"]),
	nice: new Set(["-n", "--adjustment"]),
	timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
	xargs: new Set(["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a", "--arg-file", "--delimiter", "--max-args", "--max-procs"]),
};
/** Names a fail-closed scan looks for in a command the parser cannot read. */
const GATED_PROGRAMS = ["git", "gh", ...WRITE_COMMANDS, ...IN_PLACE_COMMANDS];
const GATED_WORD = new RegExp(
	"(?<=^|[\\s;&|(`$'\"/\\\\])(" + GATED_PROGRAMS.join("|") + ")(?=\\s|$|['\"])",
);
/** A plain file path in a heredoc header: no quotes, expansions, or operators. */
const PLAIN_PATH = String.raw`[A-Za-z0-9._/~-]+`;
const HEREDOC_REDIRECT = String.raw`>>?[ \t]*${PLAIN_PATH}`;
const HEREDOC_TOKEN = String.raw`<<[ \t]*(?:'(\w+)'|"(\w+)")`;
/**
 * The only heredoc header whose body may skip the fail-closed scan: a data
 * reader (cat, tee with one file, python3/python/node with `-`), one optional
 * output redirect to a plain path, and one heredoc with a quoted delimiter.
 */
const SAFE_HEREDOC_HEADER = new RegExp(
	String.raw`^(?:cat|tee(?:[ \t]+${PLAIN_PATH})?|(?:python3|python|node)(?:[ \t]+-)?)` +
		String.raw`(?:(?:[ \t]+${HEREDOC_REDIRECT})?[ \t]+${HEREDOC_TOKEN}|[ \t]+${HEREDOC_TOKEN}(?:[ \t]+${HEREDOC_REDIRECT})?)[ \t]*$`,
);

const MAX_UNWRAP_DEPTH = 4;

/** Split one segment into shell words, removing quotes. */
export function shellWords(segment: string): string[] {
	const words: string[] = [];
	let word = "";
	let inWord = false;
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (quote === "'") {
			if (ch === "'") quote = null;
			else word += ch;
		} else if (quote === '"') {
			if (ch === '"') quote = null;
			else if (ch === "\\" && i + 1 < segment.length) word += segment[++i];
			else word += ch;
		} else if (ch === "'" || ch === '"') {
			quote = ch;
			inWord = true;
		} else if (ch === "\\" && i + 1 < segment.length) {
			word += segment[++i];
			inWord = true;
		} else if (/\s/.test(ch)) {
			if (inWord) words.push(word);
			word = "";
			inWord = false;
		} else {
			word += ch;
			inWord = true;
		}
	}
	if (inWord) words.push(word);
	return words;
}

/** A wrapped history command loses its allow: history becomes publish (ask). */
function raise(hits: Hit[]): Hit[] {
	return hits.map((hit) => (hit === "history" ? "publish" : hit));
}

/**
 * True when bash changes the segment at run time in a way the words do not
 * show: a `$` expansion or substitution outside single quotes, an unquoted
 * glob or brace, or an output redirect to a file (`2>&1` and `>/dev/null`
 * stay plain). A history command with this shape is raised to ask.
 */
function runtimeShaped(segment: string): boolean {
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (quote === "'") {
			if (ch === "'") quote = null;
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "`" || (ch === "$" && /[A-Za-z_{(0-9*@#?$!-]/.test(segment[i + 1] ?? ""))) return true;
		if (quote === '"') {
			if (ch === '"') quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') quote = ch;
		else if ("*?[{".includes(ch)) return true;
	}
	return writesFile(segment);
}

/** True when the segment redirects output to a file (`2>&1` and `>/dev/null` stay plain). */
function writesFile(segment: string): boolean {
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (quote) {
			if (ch === quote) quote = null;
			else if (ch === "\\" && quote === '"') i++;
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') quote = ch;
		else if (ch === "<" && segment[i + 1] === ">") return true;
		else if (ch === ">") {
			let j = i + 1;
			if (segment[j] === ">" || segment[j] === "|") j++;
			while (segment[j] === " " || segment[j] === "\t") j++;
			if (segment[j] === "&") {
				// A dup is plain only when the whole target is an fd or `-`: `>&0file` writes a file.
				if (!/^(\d+|-)(?=\s|$)/.test(segment.slice(j + 1))) return true;
			} else if (!/^\/dev\/null(?=\s|$)/.test(segment.slice(j))) return true;
		}
	}
	return false;
}

/**
 * The file targets of the output redirects in a command, in order, with their
 * quotes removed. `2>&1`, `>&2`, and `>/dev/null` are not targets: they change
 * no file. A target is returned as written, so the caller resolves it against
 * its own working directory.
 *
 * This exists so a platform can apply its write policy to `echo x > path`
 * exactly as it does to the `write` tool: a redirect to a file is a write, and
 * the path belongs to the policy, not only to the shell.
 */
export function redirectTargets(command: string): string[] {
	const targets: string[] = [];
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === quote) quote = null;
			else if (ch === "\\" && quote === '"') i++;
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch !== ">") continue;
		let j = i + 1;
		if (command[j] === ">") j++;
		if (command[j] === "|") j++;
		while (command[j] === " " || command[j] === "\t") j++;
		if (command[j] === "&") {
			// `>&2` and `>&-` are dups; `>&0file` writes `file`.
			j++;
			while (/\d|-/.test(command[j] ?? "")) j++;
			if (command[j] === undefined || /\s|;|&|\|/.test(command[j])) continue;
		}
		// Read the target word, keeping the quotes out of it.
		let target = "";
		let inner: "'" | '"' | null = null;
		while (j < command.length) {
			const c = command[j];
			if (inner) {
				if (c === inner) inner = null;
				else if (c === "\\" && inner === '"' && j + 1 < command.length) target += command[++j];
				else target += c;
				j++;
				continue;
			}
			if (c === "'" || c === '"') {
				inner = c;
				j++;
				continue;
			}
			if (c === "\\" && j + 1 < command.length) {
				target += command[++j];
				j++;
				continue;
			}
			if (/\s|;|&|\|/.test(c)) break;
			target += c;
			j++;
		}
		if (target !== "" && target !== "/dev/null") targets.push(target);
	}
	return targets;
}

/** True when `git branch` arguments only list branches. */
function isBranchListing(rest: string[]): boolean {
	const LIST = new Set(["-a", "--all", "-r", "--remotes", "-l", "--list", "-v", "-vv", "--verbose", "--show-current", "--merged", "--no-merged", "--contains", "--no-contains", "--sort", "--format", "--column", "--no-column", "--points-at"]);
	return rest.length === 0 || rest.includes("--show-current") || rest.includes("-l") || rest.includes("--list") || rest.every((arg) => !arg.startsWith("-") ? false : LIST.has(arg.split("=")[0]));
}

/** True when the command runs a `$(...)`, backtick, or `<(...)` substitution. */
function hasSubstitution(command: string): boolean {
	let single = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (single) {
			if (ch === "'") single = false;
		} else if (ch === "\\") i++;
		else if (ch === "'") single = true;
		else if (ch === "`" || ("$<>".includes(ch) && command[i + 1] === "(")) return true;
	}
	return false;
}

/** The hits of one parsed segment, unwrapping prefixes and `sh -c` payloads. */
function segmentGates(segment: string, depth: number): Hit[] {
	// A subshell or group keeps its brackets in the segment: `(git push)`.
	const trimmed = segment.trim();
	const inner = trimmed.replace(/^[({]\s*/, "").replace(/\s*[)}]$/, "");
	let wrapped = inner !== trimmed;
	let words = shellWords(inner);
	// A leading `cd <dir> &&` stays folded into the segment by the parser; the
	// cd counts as an ungated segment of its own.
	let cd = false;
	while (words[0] === "cd" && words[2] === "&&") {
		words = words.slice(3);
		cd = true;
	}
	const extra: Hit[] = cd ? [UNGATED] : [];
	for (;;) {
		let assigned = false;
		while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
			words = words.slice(1);
			assigned = true;
		}
		// An env assignment (GIT_DIR=x, GIT_CONFIG_*) changes what git does.
		if (assigned) wrapped = true;
		if (words.length === 0) return assigned || cd ? [UNGATED] : [];
		const command = basename(words[0]);
		// A path to the program (`/tmp/x/git`) may run something else than git.
		if (command !== words[0]) wrapped = true;
		if (PREFIX_COMMANDS.has(command)) {
			wrapped = true;
			words = words.slice(1);
			// Skip the prefix's own options (and their values), and the duration `timeout` takes.
			const valued = PREFIX_VALUE_OPTIONS[command];
			while (words.length > 0 && words[0].startsWith("-")) {
				words = words.slice(valued?.has(words[0]) ? 2 : 1);
			}
			if (command === "timeout" && words.length > 0) words = words.slice(1);
			continue;
		}
		if (SHELLS.has(command)) {
			const flag = words.findIndex((word) => /^-[a-z]*c[a-z]*$/.test(word));
			if (flag < 0 || flag + 1 >= words.length) {
				return [UNGATED];
			}
			// Never allow through a shell: the payload's history hits ask.
			const hits = depth >= MAX_UNWRAP_DEPTH ? (["publish", "write"] as Hit[]) : raise(gateCommand(words[flag + 1], depth + 1));
			return [...hits, ...extra];
		}
		let hits = classify(command, words.slice(1));
		if (wrapped || (hits.includes("history") && runtimeShaped(inner))) hits = raise(hits);
		if (writesFile(inner)) hits = [...hits, "write"];
		return [...hits, ...extra];
	}
}

/** True when `arg` is `long` or an abbreviation of it git accepts (`--amen`). */
function longOption(arg: string, long: string, min: number): boolean {
	const name = arg.split("=")[0];
	return name.length >= min && long.startsWith(name);
}

/** The hits of one plain command (no prefixes). */
function classify(command: string, args: string[]): Hit[] {
	if (WRITE_COMMANDS.has(command)) return ["write"];
	if (IN_PLACE_COMMANDS.has(command) && args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith("--in-place"))) return ["write"];
	if (command === "gh") {
		// A global option before the subcommand (`gh -R owner/repo run list`) moves the
		// word the gate reads, so skip the options first. `-R` and `--repo` take the
		// next word as their value; a `--long=value` token carries its own value.
		let g = 0;
		while (g < args.length && args[g].startsWith("-")) g += args[g] === "-R" || args[g] === "--repo" ? 2 : 1;
		const sub = args[g];
		if (sub !== undefined && GH_PUBLISH.has(sub)) return ["publish"];
		if (sub === undefined || GH_READ_COMMANDS.has(sub) || GH_READ_ACTIONS.has(args[g + 1] ?? "")) return [UNGATED];
		return ["write"];
	}
	if (command !== "git") return [UNGATED];
	const { sub, rest, unknown } = gitSubcommand(args);
	if (unknown) return ["publish"];
	if (sub && GIT_PUBLISH.has(sub)) return ["publish"];
	if (!sub) return [UNGATED];
	if (!GIT_HISTORY.has(sub)) {
		// A read that writes its output to a file (`git diff --output=x`) is a write.
		if (rest.some((arg) => arg === "--output" || arg.startsWith("--output="))) return ["write"];
		return GIT_READ.has(sub) || (sub === "branch" && isBranchListing(rest)) ? [UNGATED] : ["write"];
	}
	// Ask exceptions. Fail safe on short options: any `-x...` word that holds
	// the letter counts, because a bundle (`-fm1`) or a value can hide it.
	const short = (letters: string): boolean => rest.some((arg) => /^-[^-]/.test(arg) && [...letters].some((l) => arg.includes(l)));
	const long = (name: string, min: number): boolean => rest.some((arg) => longOption(arg, name, min));
	if (sub === "tag") {
		if (short("df") || long("--delete", 3) || long("--force", 3)) return ["publish"];
		// `git tag`, `git tag -l 'v*'`, and `git tag --contains HEAD` list tags.
		const options = rest.filter((arg) => arg.startsWith("-"));
		const listing = rest.includes("-l") || rest.includes("--list") || (options.length > 0 && options.every((arg) => GIT_TAG_LIST_OPTIONS.has(arg.split("=")[0])));
		if (rest.length === 0 || listing) return [UNGATED];
	}
	if (sub === "commit" && long("--amend", 3)) return ["publish"];
	if (sub === "pull" || sub === "merge") {
		// `--upload-pack`, a transport helper URL (`ext::sh -c ...`, `fd::`), and
		// a merge strategy (`git-merge-<name>` from PATH) run a program of the
		// caller's choice.
		if (sub === "pull" && long("--upload-pack", 5)) return ["publish"];
		if (rest.some((arg) => arg.includes("::"))) return ["publish"];
		if (short("s") || long("--strategy", 3)) return ["publish"];
	}
	// A rebase strategy runs `git-merge-<name>` from PATH. Only no-value short
	// flags may come before the `s`, so `-Xours` and `-x 'cmd'` stay plain.
	if (sub === "rebase" && (rest.some((arg) => /^-[iqvnmfrk]*s/.test(arg)) || long("--strategy", 3))) return ["publish"];
	return ["history"];
}

/**
 * True when the text after an unreadable command's `git` or `gh` word may
 * start a gated form. It skips the global options it knows. It answers true
 * for anything it cannot read (unknown option, substitution, odd quoting),
 * because a false deny is safe and a false allow is not.
 */
function gatedFormFollows(program: "git" | "gh", after: string): boolean {
	// A closing quote of a quoted program name (`"git" commit`) is not a word.
	const tokens = after.replace(/^['"]/, "").split(/\s+/).filter((token) => token !== "");
	// An option value is trusted only as one clean token. A quoted value with a
	// space splits into two tokens, and the second would read as the subcommand.
	const cleanValue = (value: string | undefined): boolean => value !== undefined && /^[^\s'"`$\\]+$/.test(value);
	for (let i = 0; i < tokens.length; i++) {
		// A separator or quote glued to the word does not change the word.
		const word = tokens[i].replace(/[;&|)'"]+$/, "");
		if (word.startsWith("-")) {
			const eq = tokens[i].indexOf("=");
			const name = eq < 0 ? tokens[i] : tokens[i].slice(0, eq);
			const takesValue = program === "gh" ? name === "-R" || name === "--repo" : GIT_PATH_OPTIONS.has(name);
			if (takesValue) {
				if (eq >= 0 ? !cleanValue(tokens[i].slice(eq + 1)) : !cleanValue(tokens[++i])) return true;
			} else if (program === "git" && !GIT_PLAIN_OPTIONS.has(word)) return true;
			continue;
		}
		const gated = program === "git" ? GIT_HISTORY.has(word) || GIT_PUBLISH.has(word) : GH_PUBLISH.has(word);
		return gated || !/^[a-z][a-z0-9-]*$/.test(word);
	}
	return false;
}

/**
 * The header without its heredoc token when the whole command is one safe
 * data heredoc, else null. The check is a strict allow-list because any shape
 * it does not know (a shell reading the body, a pipe, a later line that runs
 * the written file) must fall back to the fail-closed scan.
 * Shape: header line (SAFE_HEREDOC_HEADER), body, a closing line equal to the
 * delimiter, then only blank lines.
 * Known limit: python or node code in a body (a subprocess or child_process
 * call to git) is not inspected; `python -c '...'` has the same limit.
 */
function safeHeredocHeader(command: string): string | null {
	const lines = command.split("\n");
	const match = SAFE_HEREDOC_HEADER.exec(lines[0]);
	if (!match) return null;
	const delimiter = match.slice(1).find((group) => group !== undefined);
	if (!delimiter) return null;
	const close = lines.indexOf(delimiter, 1);
	if (close < 0) return null;
	if (!lines.slice(close + 1).every((line) => /^[ \t]*$/.test(line))) return null;
	return lines[0].replace(new RegExp(HEREDOC_TOKEN), " ");
}

/** Every hit a whole shell command makes, in no particular order. */
export function gateCommand(command: string, depth = 0): Hit[] {
	const parsed = parseShellCommand(command);
	if (parsed.unsupported) {
		const header = safeHeredocHeader(command);
		if (header !== null) return gateCommand(header, depth);
		// Fail closed: an unreadable command that names a gated program is a
		// hit, and never an allow.
		const gates = new Set<Hit>();
		for (const match of command.matchAll(new RegExp(GATED_WORD.source, "g"))) {
			const program = match[1];
			if (program === "git" || program === "gh") {
				// A read such as `git status` stays ungated; only a gated form fires.
				if (gatedFormFollows(program, command.slice(match.index + program.length))) gates.add("publish");
			} else gates.add("write");
		}
		// The first line of an unreadable command (a heredoc header) may redirect into a file.
		if (writesFile(command.split("\n")[0])) gates.add("write");
		return [...gates];
	}
	const hits = [...new Set(parsed.segments.flatMap((segment) => segmentGates(segment, depth)))];
	// A history command inside a substitution never runs without a prompt.
	return hasSubstitution(command) ? raise(hits) : hits;
}

/** The segments of a command, as the parser split them (a leading `cd` still folded in). */
export function commandSegments(command: string): string[] {
	const parsed = parseShellCommand(command);
	return parsed.unsupported ? [command] : parsed.segments;
}

/**
 * The remainder of one segment after its wrappers are stripped: a leading
 * `cd x &&`, env assignments, prefix commands (`sudo`, `env`, `xargs`, ...),
 * and brackets. Quoting is not preserved, because this is a rule candidate,
 * not a command to run.
 */
export function unwrapSegment(segment: string): string {
	const trimmed = segment.trim();
	const inner = trimmed.replace(/^[({]\s*/, "").replace(/\s*[)}]$/, "");
	let words = shellWords(inner);
	while (words[0] === "cd" && words[2] === "&&") words = words.slice(3);
	for (;;) {
		while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words = words.slice(1);
		if (words.length === 0) return "";
		const command = basename(words[0]);
		if (PREFIX_COMMANDS.has(command)) {
			words = words.slice(1);
			const valued = PREFIX_VALUE_OPTIONS[command];
			while (words.length > 0 && words[0].startsWith("-")) {
				words = words.slice(valued?.has(words[0]) ? 2 : 1);
			}
			if (command === "timeout" && words.length > 0) words = words.slice(1);
			continue;
		}
		if (SHELLS.has(command)) {
			const flag = words.findIndex((word) => /^-[a-z]*c[a-z]*$/.test(word));
			return flag >= 0 && flag + 1 < words.length ? words[flag + 1] : "";
		}
		return words.join(" ");
	}
}

/**
 * Every string a permission rule may match for one command: each segment as
 * the parser split it, and each segment with its wrappers stripped, so a rule
 * for `^git push` fires on `cd api && sudo git push` too.
 */
export function commandCandidates(command: string): string[] {
	const out = new Set<string>();
	for (const segment of commandSegments(command)) {
		out.add(segment);
		const unwrapped = unwrapSegment(segment);
		if (unwrapped !== "") out.add(unwrapped);
	}
	return [...out];
}
