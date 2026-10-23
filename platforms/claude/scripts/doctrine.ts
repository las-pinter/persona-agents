#!/usr/bin/env node
// doctrine — Claude Code PreToolUse hook for persona-agents.
//
// Enforces the commit and file doctrine from AGENTS.md for the persona-agents
// agents (agent type `persona-agents:<profession>`), whether they run as the
// main session (`claude --agent`) or as a subagent:
//
//   git add/commit/push/pull/merge/rebase/tag, gh pr, gh release
//                     orchestrator: ask; every other agent: deny
//   cp, mv, rsync     orchestrator and implementer: ask; the rest: deny
//   Edit/Write/NotebookEdit outside the agent's notes zone (FILE_ZONES)
//                     orchestrator: ask; planner, researcher, reviewer, mascot: deny
//
// A shell command is split into segments by the pi gate's parser; each segment
// is unwrapped (`cd x &&`, env/sudo/xargs/eval prefixes, `bash -c '...'`)
// before it is classified. A command the parser cannot read (a heredoc, an
// unbalanced quote) that names a gated command counts as a hit: fail closed.
// One exception: a single quoted heredoc fed to a data reader (cat, tee,
// python3 -, node -) is checked by its header only (safeHeredocHeader).
//
// Any other agent, or a session without one, gets no decision, so Claude
// Code's own permission flow runs unchanged.
//
// Set PERSONA_AGENTS_DEBUG=1 to append each hook input and decision to
// $CLAUDE_PLUGIN_DATA/doctrine.log.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseShellCommand } from "../../pi/extension/command-segments.ts";

const PREFIX = "persona-agents:";

export type Verdict = "ask" | "deny";

export interface Decision {
	verdict: Verdict;
	reason: string;
}

export interface HookInput {
	agent_type?: unknown;
	tool_name?: unknown;
	tool_input?: Record<string, unknown>;
}

type Gate = "history" | "copy";

/** Verdict per gated command class; a profession missing here is denied. */
const COMMAND_RULES: Record<Gate, Record<string, Verdict>> = {
	history: { orchestrator: "ask" },
	copy: { orchestrator: "ask", implementer: "ask" },
};

/** Why a gate fired: an ask explains the approval, a deny names who may run it. */
const GATE_REASON: Record<Gate, Record<Verdict, string>> = {
	history: {
		ask: "writing git history, or a gh pr / gh release command, needs your approval",
		deny: "only the orchestrator writes git history or runs gh pr / gh release; suggest a commit instead",
	},
	copy: {
		ask: "cp, mv, and rsync need your approval",
		deny: "cp, mv, and rsync are for the orchestrator and the implementer only",
	},
};

/**
 * Where each profession may write with Edit/Write/NotebookEdit. A profession
 * missing here writes freely. `verdict` applies outside the allowed zones.
 */
const FILE_ZONES: Record<string, { zones: RegExp[]; verdict: Verdict }> = {
	orchestrator: { zones: [/(^|\/)agent-notes\/(orchestrator|project-notes)\//], verdict: "ask" },
	planner: { zones: [/(^|\/)agent-notes\/project-notes\//], verdict: "deny" },
	researcher: { zones: [/(^|\/)agent-notes\/researcher\//], verdict: "deny" },
	reviewer: { zones: [], verdict: "deny" },
	mascot: { zones: [], verdict: "deny" },
};

const FILE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

const GIT_HISTORY = new Set(["add", "commit", "push", "pull", "merge", "rebase", "tag"]);
/** git global options that take the next token as their value. */
const GIT_VALUE_OPTIONS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);
/** `git tag` with only these options lists tags; anything else writes. */
const GIT_TAG_LIST_OPTIONS = new Set(["-l", "--list", "-n", "--contains", "--no-contains", "--points-at", "--merged", "--no-merged", "--sort", "--column", "--no-column"]);
const COPY_COMMANDS = new Set(["cp", "mv", "rsync"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
/** Prefix commands that run the rest of the line, with options to skip. */
const PREFIX_COMMANDS = new Set(["sudo", "env", "command", "nice", "nohup", "time", "exec", "xargs", "eval", "timeout", "stdbuf", "doas"]);
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

/** The gates one parsed segment hits, unwrapping prefixes and `sh -c` payloads. */
function segmentGates(segment: string, depth: number): Gate[] {
	// A subshell or group keeps its brackets in the segment: `(git push)`.
	let words = shellWords(segment.trim().replace(/^[({]\s*/, "").replace(/\s*[)}]$/, ""));
	// A leading `cd <dir> &&` stays folded into the segment by the parser.
	while (words[0] === "cd" && words[2] === "&&") words = words.slice(3);
	for (;;) {
		while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words = words.slice(1);
		if (words.length === 0) return [];
		const command = basename(words[0]);
		if (PREFIX_COMMANDS.has(command)) {
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
			if (flag < 0 || flag + 1 >= words.length) return [];
			return depth >= MAX_UNWRAP_DEPTH ? ["history", "copy"] : commandGates(words[flag + 1], depth + 1);
		}
		return classify(command, words.slice(1));
	}
}

/** The gates one plain command (no prefixes) hits. */
function classify(command: string, args: string[]): Gate[] {
	if (COPY_COMMANDS.has(command)) return ["copy"];
	if (command === "gh") return args[0] === "pr" || args[0] === "release" ? ["history"] : [];
	if (command !== "git") return [];
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) {
		i += GIT_VALUE_OPTIONS.has(args[i]) ? 2 : 1;
	}
	const sub = args[i];
	if (!sub || !GIT_HISTORY.has(sub)) return [];
	if (sub === "tag") {
		// `git tag`, `git tag -l 'v*'`, and `git tag --contains HEAD` list tags.
		const rest = args.slice(i + 1);
		const options = rest.filter((arg) => arg.startsWith("-"));
		const listing = rest.includes("-l") || rest.includes("--list") || (options.length > 0 && options.every((arg) => GIT_TAG_LIST_OPTIONS.has(arg.split("=")[0])));
		if (rest.length === 0 || listing) return [];
	}
	return ["history"];
}

/** Every gate a whole shell command hits. */
function commandGates(command: string, depth = 0): Gate[] {
	const parsed = parseShellCommand(command);
	if (parsed.unsupported) {
		const header = safeHeredocHeader(command);
		if (header !== null) return commandGates(header, depth);
		// Fail closed: an unreadable command that names a gated program is a hit.
		const gates = new Set<Gate>();
		for (const match of command.matchAll(new RegExp(GATED_WORD.source, "g"))) {
			gates.add(match[1] === "git" || match[1] === "gh" ? "history" : "copy");
		}
		return [...gates];
	}
	return [...new Set(parsed.segments.flatMap((segment) => segmentGates(segment, depth)))];
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
		const hits = commandGates(command).map((gate) => {
			const verdict = COMMAND_RULES[gate][profession] ?? "deny";
			return { verdict, reason: GATE_REASON[gate][verdict] };
		});
		return strongest(hits, profession);
	}

	if (FILE_TOOLS.has(tool)) {
		const rule = FILE_ZONES[profession];
		if (!rule) return null;
		const target = String(toolInput.file_path ?? toolInput.notebook_path ?? "");
		if (rule.zones.some((zone) => zone.test(target))) return null;
		const where = rule.zones.length > 0 ? "outside its agent-notes zone" : "at all";
		return { verdict: rule.verdict, reason: `persona-agents doctrine: the ${profession} does not edit files ${where}` };
	}
	return null;
}

/** Deny beats ask; no hit means no decision. */
function strongest(hits: Decision[], profession: string): Decision | null {
	const pick = hits.find((hit) => hit.verdict === "deny") ?? hits[0];
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
