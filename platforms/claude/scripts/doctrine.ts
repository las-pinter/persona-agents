#!/usr/bin/env node
// doctrine — Claude Code PreToolUse hook for persona-agents.
//
// Enforces the commit and file doctrine from AGENTS.md for the persona-agents
// agents (agent type `persona-agents:<profession>`), whether they run as the
// main session (`claude --agent`) or as a subagent:
//
//   plain git add/commit/pull/merge/rebase/tag
//                     orchestrator: allow; every other agent: deny
//   git push, gh pr, gh release, gh run, git tag -d/--delete/-f/--force,
//   any git global option outside GIT_PLAIN_OPTIONS / GIT_PATH_OPTIONS
//   (-c, --config-env, --exec-path, --attr-source, ...), git commit --amend,
//   git pull --upload-pack, git pull/merge with a `::` transport URL or a
//   merge strategy (-s, --strategy), and any wrapped or runtime-shaped
//   history command
//                     orchestrator: ask; every other agent: deny
//   cp, mv, rsync     orchestrator and implementer: ask; the rest: deny
//   bash <plugin root>/content/skills/common/journal-management-generic/
//   scripts/journal-write.sh <append|check|replace> ...
//                     orchestrator: allow; every other agent: no decision
//
// Allow is given only when every segment of the command is a plain history
// command or the installed journal write script. A command that mixes an
// allowed segment with an ungated one
// (`git add . && rm -rf x`) gets no decision, so Claude Code's own flow runs.
// A wrapped form (env/sudo/xargs/eval prefixes, `bash -c`, a subshell, a
// `$(...)` or backtick substitution, an env assignment, a path to git, the
// unwrap depth limit, the fail-closed scan) or a runtime-shaped one (a `$`
// expansion, a glob, an output redirect to a file) is raised to ask.
// Claude Code still applies settings deny and ask rules after a hook allow,
// and an allow from this hook never overrides an ask or deny from another
// hook (precedence deny > defer > ask > allow; see the PreToolUse decision
// control section of the Claude Code hooks documentation).
//
// Accepted risks (owner choice), allowed without a prompt:
//   git rebase --exec '<cmd>' runs <cmd>; its payload is not inspected.
//   git -C / --git-dir / --work-tree to another path runs that repository's
//   hooks and core.* config.
//
// Write zone (FILE_ZONES). Edit, Write, and NotebookEdit are allowed inside the
// zone of the agent. The orchestrator holds every tool: its zone is the
// repository, the whole agent-notes tree under the home folder, and the shared
// temporary folder; any other path asks. The planner, researcher, reviewer, and
// mascot deny every path outside their own notes zone, the temporary folder
// included. The implementer and the tester write freely.
//
// A zone is anchored to an absolute folder and tested with a path check, never
// a text match: `agent-notes` in the middle of another folder is not a zone.
// The links resolve before a parent segment folds, as the kernel resolves them,
// so a target that walks through a link and then carries `..` lands where the
// write lands. A path that does not resolve counts as outside. The repository
// zone is the session `cwd`, capped: a cwd that holds the home folder allows no
// repository path, and neither does a cwd at a system-wide folder such as
// `/tmp`, `/etc`, `/usr`, `/var`, or `/home`. A leading `~` expands to the home
// folder before the test.
//
// A shell command is split into segments by the pi gate's parser; each segment
// is unwrapped (`cd x &&`, env/sudo/xargs/eval prefixes, `bash -c '...'`)
// before it is classified. A command the parser cannot read (a heredoc, an
// unbalanced quote) that names a gated command counts as a hit: fail closed.
// The fail-closed hit is ask, never allow. One exception: a single quoted
// heredoc fed to a data reader (cat, tee, python3 -, node -) is checked by its
// header only (safeHeredocHeader).
//
// Any other agent, or a session without one, gets no decision, so Claude
// Code's own permission flow runs unchanged.
//
// Set PERSONA_AGENTS_DEBUG=1 to append each hook input and decision to
// $CLAUDE_PLUGIN_DATA/doctrine.log.

import { appendFileSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseShellCommand } from "../../pi/extension/command-segments.ts";

const PREFIX = "persona-agents:";

export type Verdict = "allow" | "ask" | "deny";

export interface Decision {
	verdict: Verdict;
	reason: string;
}

export interface HookInput {
	agent_type?: unknown;
	tool_name?: unknown;
	tool_input?: Record<string, unknown>;
	/** The session working directory, as Claude Code sends it. */
	cwd?: unknown;
}

/**
 * history: a plain git add/commit/pull/merge/rebase/tag.
 * publish: git push, and gh pr, gh release, or gh run, also when a gh global option
 * comes first, plus every history command that is an ask exception or comes
 * wrapped (see the header).
 * journal: the installed journal write script with its subcommand.
 */
type Gate = "history" | "publish" | "copy" | "journal";
/** A segment that runs a command no gate covers. */
const UNGATED = "ungated";
type Hit = Gate | typeof UNGATED;

/** Verdict per gated command class; a profession missing here is denied. */
const COMMAND_RULES: Record<Gate, Record<string, Verdict>> = {
	history: { orchestrator: "allow" },
	publish: { orchestrator: "ask" },
	copy: { orchestrator: "ask", implementer: "ask" },
	journal: { orchestrator: "allow" },
};

const HISTORY_DENY = "only the orchestrator writes git history or runs gh pr / gh release / gh run; suggest a commit instead";
const PUBLISH_ASK =
	"git push, gh pr, gh release, gh run, a tag delete or force-move, a git config override, commit --amend, or a wrapped git command needs your approval";
const JOURNAL_ALLOW = "the journal write script runs without a prompt for the orchestrator";
const JOURNAL_NO = "the journal write script runs only from its installed skill path";

/** Why a gate fired: an ask explains the approval, a deny names who may run it. */
const GATE_REASON: Record<Gate, Record<Verdict, string>> = {
	history: {
		allow: "a plain git add, commit, pull, merge, rebase, or tag runs without a prompt for the orchestrator",
		ask: PUBLISH_ASK,
		deny: HISTORY_DENY,
	},
	publish: { allow: PUBLISH_ASK, ask: PUBLISH_ASK, deny: HISTORY_DENY },
	copy: {
		allow: "cp, mv, and rsync need your approval",
		ask: "cp, mv, and rsync need your approval",
		deny: "cp, mv, and rsync are for the orchestrator and the implementer only",
	},
	// The classifier emits this hit for the orchestrator only, so ask and deny
	// stay unreachable; they carry the path rule, never a git reason.
	journal: { allow: JOURNAL_ALLOW, ask: JOURNAL_NO, deny: JOURNAL_NO },
};

interface FileZone {
	/**
	 * The agent-notes subtree this profession may write, relative to the
	 * agent-notes tree under the home folder. `""` is the whole tree; null is
	 * no notes zone.
	 */
	notes: string | null;
	/** The verdict on a path outside the zones. */
	verdict: Verdict;
	/** True when the repository is also a write zone. */
	repo?: boolean;
	/** True when the shared temporary folder is also a write zone. */
	temp?: boolean;
	/** The zone names for the ask or deny reason. */
	label: string;
}

/** The home folder: the anchor of the agent-notes zone and of a `~` path. */
const HOME = resolve(homedir());
/** The agent-notes tree. A write zone is this folder or a folder under it. */
const NOTES_ROOT = join(HOME, "agent-notes");
/**
 * The shared temporary folder. One literal, two meanings: a repository base
 * here is too wide to be a repository, and a zone with `temp` may write here.
 */
const TEMP_ROOT = "/tmp";

/**
 * Where each profession may write with Edit/Write/NotebookEdit. A profession
 * missing here writes freely. The orchestrator holds every tool, so its zone is
 * the repository, the whole agent-notes tree, and the shared temporary folder;
 * any other path asks. The planner, researcher, reviewer, and mascot keep their
 * narrow zone, so the temporary folder denies them.
 *
 * The repository zone. The tool input holds a path and no working directory.
 * The hook input holds the session `cwd`. With an absolute `cwd`, a relative
 * path resolves against it, and the path is in the repository when it equals
 * `cwd` or sits under it after `..` normalization. Without an absolute `cwd`, a
 * relative path stays in the working directory (REPO_RELATIVE), and an absolute
 * or parent-relative path cannot be placed, so it falls to the zone verdict.
 */
const FILE_ZONES: Record<string, FileZone> = {
	orchestrator: {
		notes: "",
		verdict: "ask",
		repo: true,
		temp: true,
		label: "outside the repository, the agent-notes tree, and the temporary folder",
	},
	planner: { notes: "project-notes", verdict: "deny", label: "outside its agent-notes zone" },
	researcher: { notes: "researcher", verdict: "deny", label: "outside its agent-notes zone" },
	reviewer: { notes: null, verdict: "deny", label: "at all" },
	mascot: { notes: null, verdict: "deny", label: "at all" },
};

const FILE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

/** A relative path that stays in the working directory: no root and no parent segment. */
const REPO_RELATIVE = /^(?![/~])(?!\.\.(?:\/|$))(?!.*\/\.\.(?:\/|$))/;

/** True when `child` is `parent` or sits under it. Both paths must be absolute. */
function under(child: string, parent: string): boolean {
	if (!isAbsolute(child) || !isAbsolute(parent)) return false;
	const rest = relative(parent, child);
	return rest === "" || (!rest.startsWith("..") && !isAbsolute(rest));
}

/**
 * Folders that hold unrelated trees, so a repository base at one is too wide.
 * The temporary folder is named once, in TEMP_ROOT, for both meanings.
 */
const SYSTEM_FOLDERS = new Set([TEMP_ROOT, "/etc", "/usr", "/var", "/home"]);

/**
 * The repository base of a session, or null when the cwd is too wide to be a
 * repository: the filesystem root holds every path, a cwd that holds the home
 * folder holds the whole agent-notes tree, and a system-wide folder holds
 * trees that are not one repository.
 */
function repoBase(cwdPath: string | null): string | null {
	if (cwdPath === null) return null;
	if (under(HOME, cwdPath)) return null;
	if (SYSTEM_FOLDERS.has(cwdPath)) return null;
	return cwdPath;
}

/** True when a name exists but resolves nowhere: a dangling symlink. */
function dangling(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * The real path of `path`, or null when the path cannot be placed. A relative
 * path joins onto the session `cwd`; the join keeps every segment, so no parent
 * segment folds first. The segments resolve in order: every segment that exists
 * resolves through symlinks, and a parent segment folds against that real path,
 * as the kernel folds it. Only the absent rest joins onto the last real folder.
 * A lexical test alone lets a symlink inside a zone carry the write outside the
 * zone. A loop, a denied folder, and a dangling symlink all fail the placement.
 */
function resolvedPath(path: string, cwdPath: string | null = null): string | null {
	const full = isAbsolute(path) ? path : cwdPath === null ? null : `${cwdPath.replace(/\/+$/, "")}/${path}`;
	if (full === null) return null;
	let resolved = "/";
	/** The segments after the last folder that exists. None of them is `..`. */
	const tail: string[] = [];
	for (const segment of full.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			// A parent segment folds against a real path, or against an absent name.
			if (tail.length > 0) tail.pop();
			else resolved = dirname(resolved);
			continue;
		}
		if (tail.length > 0) {
			tail.push(segment);
			continue;
		}
		const candidate = join(resolved, segment);
		try {
			resolved = realpathSync(candidate);
		} catch (error) {
			// Only an absent name starts the tail; anything else is final.
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dangling(candidate)) return null;
			tail.push(segment);
		}
	}
	return tail.length === 0 ? resolved : join(resolved, ...tail);
}

/** The target with a leading `~` or `~/` replaced by the home folder. */
function expandHome(target: string): string {
	if (target === "~") return HOME;
	return target.startsWith("~/") ? join(HOME, target.slice(2)) : target;
}

/** True when the resolved path is in the notes subtree of the rule. */
function inNotesZone(notes: string | null, path: string | null): boolean {
	if (notes === null || path === null) return false;
	const root = resolvedPath(notes === "" ? NOTES_ROOT : join(NOTES_ROOT, notes));
	return root === null ? false : under(path, root);
}

/**
 * True when the target path is in a write zone of the rule. The path expands a
 * leading `~`, joins onto the session `cwd` when the hook input carries one,
 * and resolves through symlinks before the zone test. Every zone uses
 * `resolvedPath`, so the repository zone, the notes zone, and the temporary
 * zone all resolve the links before a parent segment folds.
 */
function inWriteZone(rule: FileZone, rawTarget: string, cwd: unknown): boolean {
	const target = expandHome(rawTarget);
	const cwdPath = typeof cwd === "string" && isAbsolute(cwd) ? resolve(cwd) : null;
	const base = repoBase(cwdPath);
	// Without a cwd a relative path cannot be placed.
	const placeable = isAbsolute(target) || cwdPath !== null;
	const real = placeable ? resolvedPath(target, cwdPath) : null;
	// A path that does not resolve cannot be placed, so it stays outside.
	if (placeable && real === null) return false;
	const realBase = base === null ? null : resolvedPath(base);
	if (rule.repo && target !== "") {
		if (cwdPath === null) {
			if (REPO_RELATIVE.test(target)) return true;
		} else if (realBase !== null && real !== null && under(real, realBase)) return true;
	}
	// The temporary folder resolves through symlinks, so a link under it that
	// points outside it is not inside it. An empty target is not a temporary path.
	if (rule.temp && target !== "" && real !== null) {
		const realTemp = resolvedPath(TEMP_ROOT);
		if (realTemp !== null && under(real, realTemp)) return true;
	}
	return inNotesZone(rule.notes, real);
}

/** An ask names the approval; a deny names who may write. */
function zoneReason(rule: FileZone, profession: string): string {
	if (rule.verdict === "ask") return `persona-agents doctrine: a write ${rule.label} needs your approval`;
	return `persona-agents doctrine: the ${profession} does not edit files ${rule.label}`;
}

const GIT_HISTORY = new Set(["add", "commit", "pull", "merge", "rebase", "tag"]);
const GIT_PUBLISH = new Set(["push"]);
/**
 * The only git global options a history command may carry and still get its
 * verdict by subcommand. Any other leading option (-c, --config-env,
 * --exec-path, --attr-source, an option git adds later) makes the command
 * publish: ask for the orchestrator, deny for the rest.
 */
const GIT_PLAIN_OPTIONS = new Set([
	"--no-pager", "-p", "--paginate", "-P", "--bare", "--no-replace-objects", "--literal-pathspecs",
	"--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs", "--no-optional-locks", "--no-advice",
]);
/** Global options with a value, as the next token or after `=` (long forms). */
const GIT_PATH_OPTIONS = new Set(["-C", "--git-dir", "--work-tree", "--namespace"]);
/** Global options that only print and exit; the rest of the line is not run as a subcommand. */
const GIT_INFO_OPTIONS = new Set(["--version", "--help"]);
/** `git tag` with only these options lists tags; anything else writes. */
const GIT_TAG_LIST_OPTIONS = new Set(["-l", "--list", "-n", "--contains", "--no-contains", "--points-at", "--merged", "--no-merged", "--sort", "--column", "--no-column"]);
const COPY_COMMANDS = new Set(["cp", "mv", "rsync"]);
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
const GATED_WORD = /(?<=^|[\s;&|(`$'"/\\])(git|gh|cp|mv|rsync)(?=\s|$)/;
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

/**
 * The journal write script as this plugin installs it. The plugin cache folder
 * carries the version, so the path comes from this script's own location and
 * never from a fixed path or an environment variable. A symlink alias, a copy
 * outside the tree, and a relative word all resolve elsewhere and match nothing.
 */
const JOURNAL_SCRIPT = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"..", "..", "..",
	"content", "skills", "common", "journal-management-generic", "scripts", "journal-write.sh",
);
const JOURNAL_SUBCOMMANDS = new Set(["append", "check", "replace"]);

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
function segmentGates(segment: string, profession: string, depth: number): Hit[] {
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
				// A plain `bash <installed journal script> <subcommand> ...`.
				if (!wrapped && !runtimeShaped(inner) && isJournalWords(words, profession)) {
					return ["journal", ...extra];
				}
				return [UNGATED];
			}
			// Never allow through a shell: the payload's history hits ask.
			const hits = depth >= MAX_UNWRAP_DEPTH ? (["publish", "copy"] as Hit[]) : raise(commandGates(words[flag + 1], profession, depth + 1));
			// A payload that is only the journal call is downgraded: never allow through a shell.
			return [...hits.map((hit) => (hit === "journal" ? UNGATED : hit)), ...extra];
		}
		let hits = classify(command, words.slice(1));
		if (wrapped || (hits.includes("history") && runtimeShaped(inner))) hits = raise(hits);
		return [...hits, ...extra];
	}
}

/**
 * True only for `bash <installed script> <append|check|replace> ...` run by the
 * orchestrator. The hook checks the path and the subcommand; the script owns
 * every flag value and exits 1 or 2 with no write.
 */
function isJournalWords(words: string[], profession: string): boolean {
	return profession === "orchestrator" && words.length >= 3 && words[0] === "bash" &&
		isAbsolute(words[1]) && resolve(words[1]) === JOURNAL_SCRIPT &&
		JOURNAL_SUBCOMMANDS.has(words[2]);
}

/** True when `arg` is `long` or an abbreviation of it git accepts (`--amen`). */
function longOption(arg: string, long: string, min: number): boolean {
	const name = arg.split("=")[0];
	return name.length >= min && long.startsWith(name);
}

/** The hits of one plain command (no prefixes). */
function classify(command: string, args: string[]): Hit[] {
	if (COPY_COMMANDS.has(command)) return ["copy"];
	if (command === "gh") {
		// A global option before the subcommand (`gh -R owner/repo run list`) moves the
		// word the gate reads, so skip the options first. `-R` and `--repo` take the
		// next word as their value; a `--long=value` token carries its own value.
		let g = 0;
		while (g < args.length && args[g].startsWith("-")) g += args[g] === "-R" || args[g] === "--repo" ? 2 : 1;
		const sub = args[g];
		return sub === "pr" || sub === "release" || sub === "run" ? ["publish"] : [UNGATED];
	}
	if (command !== "git") return [UNGATED];
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) {
		const arg = args[i];
		if (GIT_INFO_OPTIONS.has(arg)) return [UNGATED];
		if (GIT_PLAIN_OPTIONS.has(arg)) i += 1;
		else if (GIT_PATH_OPTIONS.has(arg)) i += 2;
		else if (arg.startsWith("--") && GIT_PATH_OPTIONS.has(arg.split("=")[0])) i += 1;
		// An unknown option may take the next token, so the subcommand is unknown.
		else return ["publish"];
	}
	const sub = args[i];
	if (sub && GIT_PUBLISH.has(sub)) return ["publish"];
	if (!sub || !GIT_HISTORY.has(sub)) return [UNGATED];
	const rest = args.slice(i + 1);
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

/** Every hit a whole shell command makes. */
function commandGates(command: string, profession: string, depth = 0): Hit[] {
	const parsed = parseShellCommand(command);
	if (parsed.unsupported) {
		const header = safeHeredocHeader(command);
		if (header !== null) return commandGates(header, profession, depth);
		// Fail closed: an unreadable command that names a gated program is a
		// hit, and never an allow.
		const gates = new Set<Hit>();
		for (const match of command.matchAll(new RegExp(GATED_WORD.source, "g"))) {
			gates.add(match[1] === "git" || match[1] === "gh" ? "publish" : "copy");
		}
		return [...gates];
	}
	const hits = [...new Set(parsed.segments.flatMap((segment) => segmentGates(segment, profession, depth)))];
	// A history command inside a substitution never runs without a prompt.
	return hasSubstitution(command) ? raise(hits) : hits;
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

/** The doctrine decision for one tool call, or null to leave it alone. */
export function decide(input: HookInput): Decision | null {
	const agentType = typeof input.agent_type === "string" ? input.agent_type : "";
	if (!agentType.startsWith(PREFIX)) return null;
	const profession = agentType.slice(PREFIX.length);
	const tool = typeof input.tool_name === "string" ? input.tool_name : "";
	const toolInput = input.tool_input ?? {};

	if (tool === "Bash") {
		const command = typeof toolInput.command === "string" ? toolInput.command : "";
		const hits = commandGates(command, profession);
		const decisions = hits
			.filter((hit): hit is Gate => hit !== UNGATED)
			.map((gate) => {
				const verdict = COMMAND_RULES[gate][profession] ?? "deny";
				return { verdict, reason: GATE_REASON[gate][verdict] };
			});
		const decision = strongest(decisions, profession);
		// A hook allow skips Claude Code's prompt for the whole command, so allow
		// only when every segment is an allowed history command. An ungated
		// segment next to it leaves the decision to Claude Code.
		if (decision?.verdict === "allow" && hits.includes(UNGATED)) return null;
		return decision;
	}

	if (FILE_TOOLS.has(tool)) {
		const rule = FILE_ZONES[profession];
		if (!rule) return null;
		const target = String(toolInput.file_path ?? toolInput.notebook_path ?? "");
		if (inWriteZone(rule, target, input.cwd)) return null;
		return { verdict: rule.verdict, reason: zoneReason(rule, profession) };
	}
	return null;
}

/** Deny beats ask, ask beats allow; no hit means no decision. */
function strongest(hits: Decision[], profession: string): Decision | null {
	const pick = hits.find((hit) => hit.verdict === "deny") ?? hits.find((hit) => hit.verdict === "ask") ?? hits[0];
	if (!pick) return null;
	return { verdict: pick.verdict, reason: `persona-agents doctrine (${profession}): ${pick.reason}` };
}

// Run as a hook: PreToolUse JSON on stdin, a permission decision on stdout.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
	const decision = decide(input);
	if (process.env.PERSONA_AGENTS_DEBUG && process.env.CLAUDE_PLUGIN_DATA) {
		mkdirSync(process.env.CLAUDE_PLUGIN_DATA, { recursive: true });
		appendFileSync(join(process.env.CLAUDE_PLUGIN_DATA, "doctrine.log"), `${JSON.stringify({ input, decision })}\n`);
	}
	if (decision) {
		process.stdout.write(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: decision.verdict,
					permissionDecisionReason: decision.reason,
				},
			}),
		);
	}
}
