/**
 * The Pi permission policy: what one agent may do with one tool call.
 *
 * Pi has no permission engine of its own: enabled tools run with the process's
 * OS permissions. This module is therefore the whole gate, and it is a pure
 * function of the profile, the tool call, and the policy files:
 *
 *   1. floors      compiled in, always first, no file can loosen them:
 *                  credentials, destructive commands, remote scripts piped to a
 *                  shell, writes to the gate's own files
 *   2. rules       your policy files, project then user, file order, first
 *                  match wins
 *   3. grants      the rules you added from an ask in this session
 *   4. doctrine    the built-in defaults for the profile: git history is
 *                  allowed for the companion, publish asks, the reviewer is
 *                  read-only, writes stay inside the project and the notes
 *
 * Candidate strings a rule or floor sees:
 *   bash  every unwrapped segment (so `cd x && git push` matches `^git push`),
 *         then the raw command
 *   paths the path arguments, with `~` expanded
 *   other the JSON of the tool input
 *
 * A match is a JavaScript regular expression source, so it is compiled and
 * validated when the file loads: a bad pattern refuses the file instead of
 * silently matching nothing. Reading and writing the files lives in
 * policy-file.ts.
 */

import { isAbsolute, join, resolve } from "node:path";
import { commandCandidates, commandSegments, dataHeredocHeader, gateCommand, shellWords, unwrapSegment, SUPPORT, UNGATED, type Hit } from "../../shared/shell/gates.ts";
import type { Profile } from "./profile.ts";
import { expandHome, insideDir, realOrResolved } from "../../shared/paths.ts";
import { redirectTargets } from "../../shared/shell/scan.ts";

export type Verdict = "allow" | "ask" | "deny";
export type RuleScope = "user" | "project";
/** Where a decision came from, for the log, `/permissions`, and the user's trust. */
export type DecisionSource = "floor" | RuleScope | "session" | "doctrine";

export interface Rule {
	/** A tool name, or `*` for every tool. */
	tool: string;
	/** A JavaScript regular expression source. */
	match: string;
	verdict: Verdict;
	reason?: string;
}

export interface PolicyFile {
	profiles?: Record<string, { rules?: Rule[] }>;
}

export interface PolicyFileRef {
	path: string;
	scope: RuleScope;
}

export interface LoadedRule {
	rule: Rule;
	scope: RuleScope;
	file: string;
	/** 1-based position within its file, for a readable reason. */
	line: number;
	regex: RegExp;
}

export interface SessionGrant {
	tool: string;
	match: string;
	reason?: string;
}

export interface PolicyState {
	/** Project rules then user rules: the order they are evaluated in. */
	rules: LoadedRule[];
	/** The first load error per file, kept so the gate can fail closed and say why. */
	errors: { file: string; message: string }[];
	grants: SessionGrant[];
}

export interface PolicyEnv {
	/** The session working directory. */
	cwd: string;
	/** The owner's home folder. */
	home: string;
	/** The project notes folder, where notes and session logs live. */
	notesDir: string;
	/** The policy files themselves: a floor forbids writing them. */
	policyFiles?: string[];
	/** The Pi agent dir: a floor forbids editing the extension or its settings. */
	piAgentDir: string;
}

export interface Decision {
	verdict: Verdict;
	reason: string;
	source: DecisionSource;
	/** The candidate string that decided it, when a floor or rule matched. */
	matched?: string;
}

export class PolicyError extends Error {}

/** The tools whose inputs name a path. */
const PATH_TOOLS = new Set(["read", "write", "edit", "patch", "ls", "grep", "find", "apply_patch"]);
/** The tools a read-only agent must be denied. */
const WRITE_TOOLS = new Set(["write", "edit", "patch", "apply_patch"]);

/**
 * The secret-shaped paths no profile may read. A template that merely carries
 * the `.env` name (`.env.example`, `.env.sample`) is not a secret: denying it
 * would block the commit that adds one.
 */
const SECRETS = new RegExp(
	String.raw`(^|[/\\])(\.env(\.[\w-]+)?|\.envrc|credentials|id_rsa|id_ed25519|id_ecdsa)([/\\]|$)` +
		String.raw`|\.pem$|[/\\]\.ssh([/\\]|$)|[/\\]\.aws([/\\]|$)|[/\\]\.gnupg([/\\]|$)`,
);
const SECRETS_TEMPLATE = /\.env\.(example|sample|template|dist|defaults)$/;
const SECRETS_REASON = "reading credentials or environment secrets is denied by the built-in floor";

/** True when a path names a credential or a real environment file. */
export function isSecretPath(value: string): boolean {
	if (SECRETS_TEMPLATE.test(value)) return false;
	return SECRETS.test(value);
}

/**
 * Commands matched at command position only: the segment is unwrapped first,
 * so `sudo mkfs ...` matches, and `git commit -m "shutdown handler"` does not.
 * A message that mentions a dangerous word is not a dangerous command.
 */
const COMMAND_FLOORS = [
	{ re: /^mkfs(\.\w+)?\b/, reason: "formatting a filesystem is denied by the built-in floor" },
	{ re: /^dd\b[^|;&]*\bof=\/dev\//, reason: "writing raw disk devices is denied by the built-in floor" },
	{ re: /^:\s*\(\s*\)\s*\{/, reason: "a fork bomb is denied by the built-in floor" },
	{ re: /^(shutdown|reboot|halt|poweroff)\b/, reason: "power commands are denied by the built-in floor" },
	{ re: /^(chmod|chown)\b[^|;&]*\b777\b/, reason: "world-writable permissions are denied by the built-in floor" },
];
/**
 * Shapes that only exist across a pipeline, so they are matched on the whole
 * command: a remote script piped into a shell cannot be seen segment by segment.
 */
const PIPELINE_FLOORS = [
	{ re: /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|k|da)?sh\b/, reason: "piping a remote script into a shell is denied by the built-in floor" },
];
/** A policy or extension file may not be rewritten by an agent it governs. */
const GATE_FILES = /(^|[/\\])(\.git[/\\](hooks|config)([/\\]|$))/;
const GATE_FILES_REASON = "rewriting the gate's own files or git hooks is denied by the built-in floor";

/** True when dir is base or inside it. */
export const isInside = insideDir;

/** A path as an absolute path, from a redirect target or a tool argument. */
function absolutePath(value: string, env: PolicyEnv): string {
	const expanded = expandHome(value, env.home);
	return isAbsolute(expanded) ? expanded : resolve(env.cwd, expanded);
}

const PATH_KEYS = ["path", "file_path", "filePath", "target", "directory", "glob"];
const PATH_LIST_KEYS = ["paths", "files"];

/** The path arguments of a tool input, absolute where possible. */
export function pathCandidates(input: Record<string, unknown>, env: PolicyEnv): string[] {
	const found: string[] = [];
	const push = (value: unknown): void => {
		if (typeof value !== "string" || value === "") return;
		found.push(absolutePath(value, env));
	};
	for (const key of PATH_KEYS) push(input[key]);
	for (const key of PATH_LIST_KEYS) {
		const value = input[key];
		if (Array.isArray(value)) for (const item of value) push(item);
	}
	return [...new Set(found)];
}

/** The strings a rule or floor is tested against for one tool call. */
export function candidates(tool: string, input: Record<string, unknown>, env: PolicyEnv): string[] {
	if (tool === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		return commandCandidates(command).filter((value) => value !== "");
	}
	if (PATH_TOOLS.has(tool)) return pathCandidates(input, env);
	return [JSON.stringify(input ?? {})];
}

/** True when a path is one an agent may never write: the gate's own machinery. */
export function isGatePath(path: string, env: PolicyEnv): boolean {
	if (GATE_FILES.test(path)) return true;
	if (isInside(path, join(env.piAgentDir, "companion-agents"))) return true;
	if (isInside(path, join(env.piAgentDir, "extensions"))) return true;
	if (path === join(env.piAgentDir, "settings.json")) return true;
	for (const file of env.policyFiles ?? []) {
		if (path === realOrResolved(file) || path === file) return true;
	}
	return false;
}

/** The built-in floor for a tool call, or null. */
export function floorDecision(tool: string, input: Record<string, unknown>, env: PolicyEnv): Decision | null {
	const strings = candidates(tool, input, env);
	const raw = tool === "bash" && typeof input.command === "string" ? input.command : "";
	const deny = (reason: string, matched: string): Decision => ({ verdict: "deny", reason, source: "floor", matched });

	if (PATH_TOOLS.has(tool)) {
		for (const value of [...strings, raw]) if (isSecretPath(value)) return deny(SECRETS_REASON, value);
	}
	if (WRITE_TOOLS.has(tool)) {
		for (const value of strings) if (isGatePath(value, env)) return deny(GATE_FILES_REASON, value);
	}
	if (tool === "bash") {
		// Command floors run on the unwrapped segment, so a prefix (`sudo`) does
		// not hide the command and a word inside an argument does not fire.
		for (const segment of commandSegments(raw)) {
			const command = unwrapSegment(segment);
			for (const { re, reason } of COMMAND_FLOORS) if (re.test(command)) return deny(reason, command);
		}
		for (const { re, reason } of PIPELINE_FLOORS) if (re.test(raw)) return deny(reason, raw);
		// A word is a path too: `cat .env` has no separator before the name.
		const words = commandSegments(raw).flatMap((segment) => shellWords(segment));
		for (const value of [...strings, raw, ...words]) if (isSecretPath(value)) return deny(SECRETS_REASON, value);
		// A redirect writes a file, and that file is subject to the same floor.
		for (const target of redirectTargets(raw)) {
			const path = absolutePath(target, env);
			if (isGatePath(path, env)) return deny(GATE_FILES_REASON, path);
		}
		// A gate file named as an argument is still a write attempt in disguise
		// (`sh -c 'echo > policy.json'` is caught by the parser, `tee file` here).
		const normalized = raw.replace(/^~(?=\/)/gm, env.home);
		for (const file of [...(env.policyFiles ?? []), join(env.piAgentDir, "settings.json")]) {
			if (normalized.includes(file)) return deny(GATE_FILES_REASON, file);
		}
	}
	return null;
}

/** The first rule that matches the tool call, or null. */
export function matchRule(
	rules: LoadedRule[],
	tool: string,
	input: Record<string, unknown>,
	env: PolicyEnv,
): { loaded: LoadedRule; matched: string } | null {
	const strings = candidates(tool, input, env);
	for (const rule of rules) {
		if (rule.rule.tool !== "*" && rule.rule.tool !== tool) continue;
		for (const value of strings) {
			if (rule.regex.test(value)) return { loaded: rule, matched: value };
		}
	}
	return null;
}

/** The first session grant that matches the tool call, or null. */
export function matchGrant(
	grants: SessionGrant[],
	tool: string,
	input: Record<string, unknown>,
	env: PolicyEnv,
): { grant: SessionGrant; matched: string } | null {
	const strings = candidates(tool, input, env);
	for (const grant of grants) {
		if (grant.tool !== "*" && grant.tool !== tool) continue;
		const regex = new RegExp(grant.match);
		for (const value of strings) if (regex.test(value)) return { grant, matched: value };
	}
	return null;
}

/** The doctrine reason for one gate, per verdict. */
function gateReason(hit: Hit): string {
	if (hit === "publish") return "publishing (push, pr, release, run, or a program-running git verb) needs your approval";
	if (hit === "history") return "a git command runs without a prompt";
	if (hit === "write") return "a shell write is allowed for a writable agent";
	return "a command outside the gates";
}

/**
 * The first file argument of a write segment that lies outside the project and
 * the notes, or null.
 *
 * The shell gate says a segment writes; this says where. A relative path is
 * resolved against the session cwd, `~` against the home folder. A
 * `--flag=value` path (such as `git diff --output=/tmp/x`) is checked by its
 * value.
 */
function outsideWriteTarget(command: string, env: PolicyEnv): string | null {
	for (const raw of commandSegments(command)) {
		const segment = unwrapSegment(raw);
		if (!gateCommand(segment).includes("write")) continue;
		for (const word of shellWords(segment).slice(1)) {
			const value = word.includes("=") ? word.slice(word.indexOf("=") + 1) : word;
			if (value === "" || value.startsWith("-")) continue;
			const path = absolutePath(value, env);
			if (!isInside(path, env.cwd) && !isInside(path, env.notesDir)) return path;
		}
	}
	return null;
}

/** The shell verbs a read-only profile may run, beyond the gated check. */
const READ_SHELL_VERBS = new Set([
	"ls", "pwd", "cat", "head", "tail", "wc", "grep", "rg", "find", "tree", "file", "stat",
	"diff", "jq", "git", "gh", "true", "echo", "printf", "which", "type", "test",
]);

/** True when every segment of a command is a read or a test. */
function readOnlyShell(command: string): boolean {
	for (const raw of commandSegments(command)) {
		const words = shellWords(unwrapSegment(raw));
		const verb = words[0] ?? "";
		if (verb === "node" && words.slice(1).some((word) => word === "--test" || word.startsWith("--test="))) continue;
		if (verb === "npx" && ["tsc", "shellcheck"].includes(words[1] ?? "")) continue;
		if (verb === "npm" && words[1] === "test") continue;
		if (!READ_SHELL_VERBS.has(verb)) return false;
	}
	return true;
}

/** The built-in verdict for a tool call, with no policy file involved. */
export function doctrineDecision(profile: Profile, tool: string, input: Record<string, unknown>, env: PolicyEnv): Decision {
	if (tool === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		const hits = gateCommand(command);
		if (!profile.writable) {
			const gated = hits.filter((hit) => hit !== UNGATED && hit !== SUPPORT);
			if (gated.length > 0) {
				return {
					verdict: "deny",
					reason: "this agent is read-only: it may run reads and tests, not history, publishes, or shell writes",
					source: "doctrine",
					matched: command,
				};
			}
			if (!readOnlyShell(command)) {
				return {
					verdict: "deny",
					reason: "this agent is read-only: it may run reads and tests only",
					source: "doctrine",
					matched: command,
				};
			}
			return { verdict: "allow", reason: "a read-only shell command", source: "doctrine" };
		}
		// A redirect is a write, so the same place rule applies: inside the
		// project or the notes, nowhere else. A write command's path arguments
		// are checked the same way. The shell gate reads one quoted data heredoc
		// by its header only, so the place rule reads the header too: the header
		// decides which files the shell opens, and a path in a body names none.
		// Two limits: python and node run the body as code, which no rule reads
		// (as with `python -c`), and a header the shared allow-list rejects falls
		// back to the whole text. A word the shell resolves at run time (`$VAR`,
		// `~user`) is resolved here as a literal path, so the place rule cannot see
		// where it lands; the doctrine records that as an accepted risk.
		const inspected = dataHeredocHeader(command) ?? command;
		const outside =
			outsideWriteTarget(inspected, env) ??
			redirectTargets(inspected)
				.map((target) => absolutePath(target, env))
				.find((path) => !isInside(path, env.cwd) && !isInside(path, env.notesDir));
		if (outside) {
			return {
				verdict: "deny",
				reason: "shell writes stay inside the project and the project notes folder; ask the owner to change the policy",
				source: "doctrine",
				matched: outside,
			};
		}
		if (hits.includes("publish")) {
			return { verdict: "ask", reason: gateReason("publish"), source: "doctrine", matched: command };
		}
		if (hits.includes("history")) return { verdict: "allow", reason: gateReason("history"), source: "doctrine" };
		return { verdict: "allow", reason: "no gate fired for this command", source: "doctrine" };
	}
	if (WRITE_TOOLS.has(tool)) {
		if (!profile.writable) {
			return { verdict: "deny", reason: "this agent is read-only: it may not change files", source: "doctrine" };
		}
		const paths = pathCandidates(input, env);
		const outside = paths.find((path) => !isInside(path, env.cwd) && !isInside(path, env.notesDir));
		if (outside) {
			return {
				verdict: "deny",
				reason: "writes stay inside the project and the project notes folder; ask the owner to change the policy",
				source: "doctrine",
				matched: outside,
			};
		}
		return { verdict: "allow", reason: "a write inside the project or the notes", source: "doctrine" };
	}
	if (!profile.writable && !["read", "grep", "find", "ls"].includes(tool)) {
		return { verdict: "deny", reason: "this agent is read-only", source: "doctrine" };
	}
	return { verdict: "allow", reason: "no gate covers this tool", source: "doctrine" };
}

/** Escape a string for use inside a regular expression. */
export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The rule a "always allow" answer should write for a tool call, and the string
 * it matched. A shell command is narrowed to its verb (`^git\s+push\b`) so the
 * grant covers the publish family rather than one exact argv; anything else is
 * anchored to the exact candidate.
 */
export function suggestGrant(
	tool: string,
	input: Record<string, unknown>,
	env: PolicyEnv,
): { match: string; matched: string } {
	if (tool === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		const candidates = commandCandidates(command).filter((value) => shellWords(value)[0] !== "cd");
		const segment =
			candidates.find((value) => gateCommand(value).includes("publish")) ??
			candidates.find((value) => gateCommand(value).some((hit) => hit !== UNGATED && hit !== SUPPORT)) ??
			candidates[0] ??
			command;
		const words = shellWords(segment);
		if (words.length >= 2 && (words[0] === "git" || words[0] === "gh")) {
			return { match: `^${escapeRegExp(words[0])}\\s+${escapeRegExp(words[1])}\\b`, matched: segment };
		}
		return { match: `^${escapeRegExp(segment)}$`, matched: segment };
	}
	const matched = candidates(tool, input, env)[0] ?? JSON.stringify(input ?? {});
	return { match: `^${escapeRegExp(matched)}$`, matched };
}

/** The whole decision for one tool call. */
export function decidePolicy(
	profile: Profile,
	tool: string,
	input: Record<string, unknown>,
	state: PolicyState,
	env: PolicyEnv,
): Decision {
	// A policy file that does not parse must not silently widen the gate.
	if (state.errors.length > 0) {
		const first = state.errors[0];
		return {
			verdict: "deny",
			reason: `the permission policy failed to load, so the gate fails closed: ${first.message}`,
			source: "floor",
			matched: first.file,
		};
	}
	const floor = floorDecision(tool, input, env);
	if (floor) return floor;
	const found = matchRule(state.rules, tool, input, env);
	if (found) {
		const { scope, line, file, rule } = found.loaded;
		const where = `${scope} rule ${line} in ${file}`;
		return {
			verdict: rule.verdict,
			reason: `${rule.reason ?? `matches /${rule.match}/`} (${where})`,
			source: scope,
			matched: found.matched,
		};
	}
	const grant = matchGrant(state.grants, tool, input, env);
	if (grant) {
		return {
			verdict: "allow",
			reason: `you allowed this for the session (${grant.grant.match})`,
			source: "session",
			matched: grant.matched,
		};
	}
	return doctrineDecision(profile, tool, input, env);
}

/**
 * The part of a tool input the audit trail keeps. A write or edit carries the
 * file body, which can hold secrets, so only its path arguments are logged.
 */
function loggedInput(tool: string, input: Record<string, unknown>): Record<string, unknown> {
	if (tool === "bash") return { command: input.command };
	if (!WRITE_TOOLS.has(tool)) return input;
	const kept: Record<string, unknown> = {};
	for (const key of [...PATH_KEYS, ...PATH_LIST_KEYS]) if (key in input) kept[key] = input[key];
	return kept;
}

/** One JSONL line per decision, for the audit trail and the retro. */
export function decisionRecord(
	profile: Profile,
	tool: string,
	input: Record<string, unknown>,
	decision: Decision,
	extra: { at?: string; session?: string } = {},
): string {
	return JSON.stringify({
		at: extra.at ?? new Date().toISOString(),
		session: extra.session ?? null,
		agent: profile.id,
		tool,
		input: loggedInput(tool, input),
		verdict: decision.verdict,
		source: decision.source,
		reason: decision.reason,
		matched: decision.matched ?? null,
	});
}
