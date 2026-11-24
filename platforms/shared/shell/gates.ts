/**
 * Shell gates: what one shell command touches, independent of any platform.
 *
 * One command is split into segments by the shell parser, each segment is
 * unwrapped (`cd x &&`, env/sudo/xargs/eval prefixes, `bash -c '...'`), and
 * classified into one of four gates:
 *
 *   history: a git command that is not a read and not publish (add, commit,
 *            reset, rebase, tag writes, ...)
 *   publish: git push, a gh pr/release/run write (create, merge, delete,
 *            cancel, ...), a git option that runs a program of the caller's
 *            choice, or any wrapped or runtime-shaped command. A gh read
 *            action (view, list, status, diff, checks, search) is ungated.
 *   write:   a file-changing command or an output redirect to a file
 *   support: an inert part beside a history command: a `cd` into a session
 *            directory, a read-only git command, a project formatter, or a
 *            read-only filter that follows a pipe
 *
 * A segment no gate covers is `ungated`. A platform decides the verdict for
 * each hit: the Claude hook (`platforms/claude/scripts/doctrine.ts`), the Pi
 * gate (`platforms/pi/scripts/policy.ts`), and the Kiro gate share this file,
 * so one parser owns every safety decision on every adapter. A wrapper, a
 * command substitution, or an output redirect removes support: support becomes
 * ungated and history becomes publish. A runtime-shaped git read is not
 * support, because a `$VAR` or a glob can hide `--output` or `--edit`.
 *
 * A command the parser cannot read (a heredoc, an unbalanced quote) that holds
 * a gated form counts as a hit: fail closed. Unreadable text with only git read
 * verbs (status, diff, log) is not a hit. One exception: a single quoted
 * heredoc fed to a data reader (cat, tee, python3 -, node -) is checked by its
 * header only (safeHeredocHeader).
 */

import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { normalizeHeredocs, safeHeredocHeader } from "./heredoc.ts";
import { isFormatter, isInertFilter } from "./inert.ts";
import { parseShellCommand } from "./shell-parse.ts";
import { shellWords } from "./shell-words.ts";
import { expandHome, insideDir } from "../paths.ts";
import { hasSubstitution, writesFile, runtimeShaped } from "./scan.ts";

export { insideDir };

export { normalizeHeredocs } from "./heredoc.ts";
export { shellWords } from "./shell-words.ts";

export type Hit = "history" | "publish" | "write" | typeof SUPPORT | typeof UNGATED;
/** A segment that is inert beside a history command: a session cd, a read, a formatter, a pipe filter. */
export const SUPPORT = "support";
/** A segment that runs a command no gate covers. */
export const UNGATED = "ungated";
/** A gated segment: the kinds an adapter turns into a verdict. */
export type GateHit = Exclude<Hit, typeof SUPPORT | typeof UNGATED>;

/** What a `cd` part needs to decide whether its target is a session directory. */
export interface GateOptions {
	/** The directory the command starts in; each `cd` resolves against it. */
	cwd?: string;
	/** True when an absolute path is a session working directory. */
	isSessionDir?: (path: string) => boolean;
	/** The home folder for `~` expansion; the process home by default. */
	home?: string;
}

const GIT_PUBLISH = new Set(["push"]);
/** Git verbs that take a repository or a remote, where a transport URL matters. */
const GIT_REMOTE_VERBS = new Set([
	"pull", "merge", "fetch", "clone", "ls-remote", "submodule", "archive", "push", "remote", "lfs", "svn", "p4",
	"send-email", "fetch-pack", "send-pack", "upload-pack", "receive-pack", "http-push", "http-fetch", "daemon",
]);
/** Git verbs that run another program, write config, or reach a remote: an ask. */
const GIT_PROGRAM = new Set([
	"config", "remote", "bisect", "submodule", "difftool", "mergetool", "filter-branch", "credential",
	"fetch", "clone", "ls-remote", "archive", "lfs", "svn", "p4", "send-email",
	"fetch-pack", "send-pack", "http-push", "http-fetch",
]);
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
export function gitSubcommand(args: string[]): { sub: string; rest: string[]; unknown: boolean; pathOption: boolean } {
	let i = 0;
	let pathOption = false;
	while (i < args.length && args[i].startsWith("-")) {
		const arg = args[i];
		if (GIT_INFO_OPTIONS.has(arg)) return { sub: "", rest: [], unknown: false, pathOption };
		if (GIT_PLAIN_OPTIONS.has(arg)) i += 1;
		else if (GIT_PATH_OPTIONS.has(arg)) {
			pathOption = true;
			i += 2;
		} else if (arg.startsWith("--") && GIT_PATH_OPTIONS.has(arg.split("=")[0])) {
			pathOption = true;
			i += 1;
		}
		// An unknown option may take the next token, so the subcommand is unknown.
		else return { sub: "", rest: [], unknown: true, pathOption };
	}
	return { sub: args[i] ?? "", rest: args.slice(i + 1), unknown: false, pathOption };
}
/** `git tag` with only these options lists tags; anything else writes. */
const GIT_TAG_LIST_OPTIONS = new Set(["-l", "--list", "-n", "--contains", "--no-contains", "--points-at", "--merged", "--no-merged", "--sort", "--column", "--no-column"]);
/** The words that are not the value of `-m` / `--message`. */
function withoutMessage(rest: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < rest.length; i += 1) {
		const arg = rest[i];
		if ((arg === "-m" || longOption(arg, "--message", 4)) && !arg.includes("=")) {
			i += 1;
			continue;
		}
		if (/^-[^-]./.test(arg) && arg.startsWith("-m")) continue;
		if (longOption(arg, "--message", 4)) continue;
		out.push(arg);
	}
	return out;
}

/** `git tag` with no options or only listing options, and no tag-creating option. */
function isTagListing(rest: string[]): boolean {
	const options = rest.filter((arg) => arg.startsWith("-"));
	// `-m`, `-F`, `-a`, and `-s` take a value or annotate, so an `-l` after one
	// of them is a value, not the list flag. A cluster or an abbreviation counts.
	if (
		rest.some(
			(arg) =>
				(/^-[^-]/.test(arg) && ["m", "F", "a", "s"].some((letter) => arg.includes(letter))) ||
				longOption(arg, "--message", 5) ||
				longOption(arg, "--file", 4) ||
				longOption(arg, "--annotate", 6) ||
				longOption(arg, "--sign", 5),
		)
	) {
		return false;
	}
	return (
		rest.length === 0 ||
		rest.includes("-l") ||
		rest.includes("--list") ||
		(options.length > 0 && options.every((arg) => GIT_TAG_LIST_OPTIONS.has(arg.split("=")[0])))
	);
}
/** Commands that change files. */
const WRITE_COMMANDS = new Set([
	"cp", "mv", "rsync", "rm", "rmdir", "tee", "dd", "truncate", "install", "ln", "mkdir", "touch",
	"chmod", "chown", "chgrp", "patch", "shred", "unlink", "scp", "curl", "wget",
	"unzip", "gunzip", "bunzip2", "xz", "zstd",
]);
/** Commands that change files only with an in-place flag (`sed -i`, `perl -pi`). */
const IN_PLACE_COMMANDS = new Set(["sed", "perl", "ruby"]);
/** Git verbs that only read; any other verb is a write. */
const GIT_READ = new Set([
	"status", "diff", "log", "show", "blame", "rev-parse", "ls-files", "ls-tree", "grep", "describe",
	"shortlog", "cat-file", "merge-base", "rev-list", "show-ref", "reflog", "version", "help", "range-diff",
	"whatchanged", "name-rev", "for-each-ref", "check-ignore", "check-attr", "var",
]);
/**
 * Read verbs that are inert beside a history command. The rest stay ungated:
 * `grep -O` runs a pager, `cat-file --filters` runs a filter, `reflog`
 * rewrites history, and `help` launches a viewer.
 */
const GIT_INERT_READ = new Set([
	"status", "diff", "log", "show", "blame", "rev-parse", "ls-files", "ls-tree", "describe",
	"shortlog", "merge-base", "rev-list", "show-ref", "range-diff", "whatchanged", "name-rev",
	"for-each-ref", "check-ignore", "check-attr", "var", "version",
]);
/** Diff options that run a configured helper program. */
const GIT_DIFF_PROGRAM = ["--ext-diff", "--textconv"];
/** gh actions that only read (`gh issue list`, `gh pr view`, `gh run list`). */
const GH_READ_ACTIONS = new Set(["list", "ls", "view", "status", "diff", "checks", "search"]);
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

const MAX_UNWRAP_DEPTH = 4;

/**
 * A `cd` target as a resolved absolute path when it is a session directory,
 * else null. `~` expands to the home folder; an expansion, a glob, a quote
 * form we cannot read, or `cd -` is null.
 */
function cdPath(target: string, dir: string | undefined, options: GateOptions): string | null {
	if (target === "-" || /[$`*?[\]{}]/.test(target)) return null;
	const home = options.home ?? homedir();
	let path: string;
	if (target === "") path = home;
	else if (target.startsWith("~") && target !== "~" && !target.startsWith("~/")) return null;
	else path = expandHome(target, home);
	const base = dir ?? options.cwd;
	const resolved = isAbsolute(path) ? resolve(path) : base === undefined ? null : resolve(base, path);
	if (resolved === null || options.isSessionDir === undefined) return null;
	return options.isSessionDir(resolved) ? resolved : null;
}

/** A wrapped command loses its support: history becomes publish, support becomes ungated. */
function raise(hits: Hit[]): Hit[] {
	return hits.map((hit) => (hit === "history" ? "publish" : hit === SUPPORT ? UNGATED : hit));
}

/** True when `git branch` arguments only list branches. */
function isBranchListing(rest: string[]): boolean {
	const LIST = new Set(["-a", "--all", "-r", "--remotes", "-l", "--list", "-v", "-vv", "--verbose", "--show-current", "--merged", "--no-merged", "--contains", "--no-contains", "--sort", "--format", "--column", "--no-column", "--points-at"]);
	return rest.length === 0 || rest.includes("--show-current") || rest.includes("-l") || rest.includes("--list") || rest.every((arg) => !arg.startsWith("-") ? false : LIST.has(arg.split("=")[0]));
}

/** One segment's hits and the directory it leaves the shell in. */
interface SegmentResult {
	hits: Hit[];
	dir: string | undefined;
}

/** The hits of one parsed segment, unwrapping prefixes and `sh -c` payloads. */
function segmentGates(
	segment: string,
	depth: number,
	options: GateOptions,
	afterPipe: boolean,
	startDir: string | undefined,
): SegmentResult {
	// A subshell or group keeps its brackets in the segment: `(git push)`.
	const trimmed = segment.trim();
	const inner = trimmed.replace(/^[({]\s*/, "").replace(/\s*[)}]$/, "");
	let wrapped = inner !== trimmed;
	let words = shellWords(inner);
	// A leading `cd <dir> &&` stays folded into the segment by the parser. Each
	// cd resolves against the running directory, which carries across segments;
	// it is support only when its target is a session directory.
	let dir = startDir ?? options.cwd;
	// A pipe feeds the first command after the separator; a `cd` does not pass
	// the pipe on to the command after its `&&`.
	let pipeMember = afterPipe;
	const extra: Hit[] = [];
	while (words[0] === "cd") {
		const joined = words[2] === "&&";
		// `cd a b` is not a form the gate reads; it stays ungated below.
		if (!joined && words.length > 2) break;
		const resolved = cdPath(words[1] ?? "", dir, options);
		words = words.slice(joined ? 3 : Math.min(words.length, 2));
		if (resolved === null) extra.push(UNGATED);
		else {
			extra.push(SUPPORT);
			dir = resolved;
		}
		if (joined) pipeMember = false;
		if (!joined) break;
	}
	for (;;) {
		let assigned = false;
		while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
			words = words.slice(1);
			assigned = true;
		}
		// An env assignment (GIT_DIR=x, GIT_CONFIG_*) changes what git does.
		if (assigned) wrapped = true;
		if (words.length === 0) return { hits: assigned ? [UNGATED] : extra, dir };
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
				return { hits: [UNGATED], dir };
			}
			// Never allow through a shell: the payload's history hits ask.
			const hits =
				depth >= MAX_UNWRAP_DEPTH
					? (["publish", "write"] as Hit[])
					: raise(gateCommand(words[flag + 1], depth + 1, { ...options, cwd: dir }));
			return { hits: [...hits, ...extra], dir };
		}
		const runtime = runtimeShaped(inner);
		let hits = classify(command, words.slice(1), pipeMember, runtime);
		if (wrapped || (hits.includes("history") && runtime)) hits = raise(hits);
		if (writesFile(inner)) hits = [...hits, "write"];
		return { hits: [...hits, ...extra], dir };
	}
}

/** True when `arg` is `long` or an abbreviation of it git accepts (`--amen`). */
function longOption(arg: string, long: string, min: number): boolean {
	const name = arg.split("=")[0];
	return name.length >= min && long.startsWith(name);
}

/** The hits of one plain command (no prefixes). */
function classify(command: string, args: string[], afterPipe: boolean, runtime: boolean): Hit[] {
	if (WRITE_COMMANDS.has(command)) return ["write"];
	if (IN_PLACE_COMMANDS.has(command) && args.some((arg) => /^-[a-zA-Z]*i/.test(arg) || arg.startsWith("--in-place"))) return ["write"];
	if (command === "find" && args.some((arg) => ["-delete", "-exec", "-execdir", "-ok", "-okdir"].includes(arg))) return ["write"];
	if (command === "tar" && args.some((arg) => /^-[a-zA-Z]*x/.test(arg) || arg === "--extract")) return ["write"];
	if (command === "gh") {
		// A global option before the subcommand (`gh -R owner/repo run list`) moves the
		// word the gate reads, so skip the options first. `-R` and `--repo` take the
		// next word as their value; a `--long=value` token carries its own value.
		let g = 0;
		while (g < args.length && args[g].startsWith("-")) g += args[g] === "-R" || args[g] === "--repo" ? 2 : 1;
		const sub = args[g];
		// A publish sub-command's read action (`gh pr view`, `gh run list`) only
		// reads; every other action (`gh pr merge`, `gh run delete`) is publish.
		if (sub !== undefined && GH_PUBLISH.has(sub) && !GH_READ_ACTIONS.has(args[g + 1] ?? "")) return ["publish"];
		if (sub === undefined || GH_READ_COMMANDS.has(sub) || GH_READ_ACTIONS.has(args[g + 1] ?? "")) return [UNGATED];
		return ["write"];
	}
	if (command !== "git") {
		// A known formatter is inert beside a history command; so is a read-only
		// filter whose only input is the pipe it follows.
		if (isFormatter(command, args)) return [SUPPORT];
		if (afterPipe && isInertFilter(command, args)) return [SUPPORT];
		return [UNGATED];
	}
	const { sub, rest, unknown } = gitSubcommand(args);
	if (unknown) return ["publish"];
	if (sub && GIT_PUBLISH.has(sub)) return ["publish"];
	if (!sub) return [UNGATED];
	// `--upload-pack` and a `::` transport helper run or fetch a program of the
	// caller's choice. Checked before the read and output paths, and only for a
	// verb that takes a repository or a remote, so a commit message may hold `::`.
	if (GIT_REMOTE_VERBS.has(sub) && withoutMessage(rest).some((arg) => arg.includes("::") || longOption(arg, "--upload-pack", 5))) return ["publish"];
	// A read that writes its output to a file (`git diff --output=x`) is a write.
	if (rest.some((arg) => arg === "--output" || arg.startsWith("--output="))) return ["write"];
	// A read stays ungated, so a read-only agent keeps it. Only the plain read
	// verbs are support beside a history command: one that runs a helper, can
	// rewrite history, or can reach a remote keeps today's no-allow behavior. A
	// `$VAR` or a glob hides an option the words do not show (`git log $OPS`
	// may be `--output=file`), so a runtime-shaped read is not support either.
	if (GIT_READ.has(sub)) {
		if (!GIT_INERT_READ.has(sub)) return [UNGATED];
		if (rest.some((arg) => GIT_DIFF_PROGRAM.some((name) => longOption(arg, name, 5)))) return [UNGATED];
		return runtime ? [UNGATED] : [SUPPORT];
	}
	if ((sub === "branch" && isBranchListing(rest)) || (sub === "tag" && isTagListing(rest))) return runtime ? [UNGATED] : [SUPPORT];
	// Read forms of a verb that can also write config or a remote.
	const firstWord = rest.find((arg) => !arg.startsWith("-"));
	if (sub === "config") {
		const writeActions = ["--unset", "--add", "--replace-all", "--rename-section", "--remove-section", "--edit", "--set"];
		const nameOf = (arg: string): string => arg.split("=")[0];
		const writeAction = rest.some((arg) => arg === "-e" || writeActions.some((action) => action.startsWith(nameOf(arg)) || nameOf(arg).startsWith(action)));
		const readAction = rest.some((arg) => arg === "-l" || nameOf(arg).startsWith("--get") || nameOf(arg).startsWith("--list"));
		const words = rest.filter((arg) => !arg.startsWith("-"));
		// `git config user.name` reads one key; `git config key=value` writes.
		if (!writeAction && (readAction || (words.length === 1 && !words[0].includes("=")))) return runtime ? [UNGATED] : [SUPPORT];
	}
	// `git remote show` reaches the remote, so it keeps the no-allow behavior;
	// listing the remotes and reading a URL are local reads.
	if (sub === "remote" && firstWord === "show") return [UNGATED];
	if (sub === "remote" && (firstWord === undefined || firstWord === "get-url")) return runtime ? [UNGATED] : [SUPPORT];
	// Ask exceptions. Fail safe on short options: any `-x...` word that holds
	// the letter counts, because a bundle (`-fm1`) or a value can hide it.
	const short = (letters: string): boolean => rest.some((arg) => /^-[^-]/.test(arg) && [...letters].some((l) => arg.includes(l)));
	const long = (name: string, min: number): boolean => rest.some((arg) => longOption(arg, name, min));
	// A verb that runs another program, writes config, or reaches a remote.
	if (GIT_PROGRAM.has(sub)) return ["publish"];
	if (sub === "pull" || sub === "merge" || sub === "rebase") {
		// A merge strategy (`git-merge-<name>` from PATH) runs a program of the
		// caller's choice. A rebase strategy is caught only in the short flags
		// before an `s`, so `-Xours` and `-x 'cmd'` stay plain.
		if (sub === "rebase" ? rest.some((arg) => /^-[iqvnmfrk]*s/.test(arg)) || long("--strategy", 3) : short("s") || long("--strategy", 3)) {
			return ["publish"];
		}
	}
	// Every other git command is local work: the owner allows it, the reviewer
	// still has no shell write, and publishing stays an ask.
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
		const gated = program === "git" ? !GIT_READ.has(word) : GH_PUBLISH.has(word);
		return gated || !/^[a-z][a-z0-9-]*$/.test(word);
	}
	return false;
}

/**
 * The header of one whole-command quoted data heredoc, or null. A platform that
 * reads a data heredoc by its header (the Pi write-place rule) composes through
 * this entry point, so the gate and the rule cannot drift apart.
 */
export function dataHeredocHeader(command: string): string | null {
	return safeHeredocHeader(normalizeHeredocs(command));
}

/** Every hit a whole shell command makes, in no particular order. */
export function gateCommand(command: string, depth = 0, options: GateOptions = {}): Hit[] {
	const text = normalizeHeredocs(command);
	const parsed = parseShellCommand(text);
	if (parsed.unsupported) {
		const header = safeHeredocHeader(text);
		if (header !== null) return gateCommand(header, depth, options);
		// Fail closed: an unreadable command that names a gated program is a
		// hit, and never an allow.
		const gates = new Set<Hit>();
		for (const match of text.matchAll(new RegExp(GATED_WORD.source, "g"))) {
			const program = match[1];
			if (program === "git" || program === "gh") {
				// A read such as `git status` stays ungated; only a gated form fires.
				if (gatedFormFollows(program, text.slice(match.index + program.length))) gates.add("publish");
			} else gates.add("write");
		}
		// The first line of an unreadable command (a heredoc header) may redirect into a file.
		if (writesFile(text.split("\n")[0])) gates.add("write");
		return [...gates];
	}
	const all: Hit[] = [];
	let dir = options.cwd;
	for (let index = 0; index < parsed.segments.length; index++) {
		const separator = parsed.separators[index];
		const result = segmentGates(parsed.segments[index], depth, options, separator === "|" || separator === "|&", dir);
		dir = result.dir;
		all.push(...result.hits);
	}
	const hits = [...new Set(all)];
	// A history command inside a substitution never runs without a prompt, and
	// no inert part survives one.
	return hasSubstitution(text) ? raise(hits) : hits;
}

/** The segments of a command, as the parser split them (a leading `cd` still folded in). */
export function commandSegments(command: string): string[] {
	const text = normalizeHeredocs(command);
	const parsed = parseShellCommand(text);
	return parsed.unsupported ? [text] : parsed.segments;
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
