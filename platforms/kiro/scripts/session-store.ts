/**
 * The Kiro CLI V3 session store, read into the shared entry shape.
 *
 * A V3 session lives at `<kiro home>/sessions/<workspace-hash>/sess_<uuid>/`:
 *
 *   session.json    the session metadata: id, title, agentMode (the agent
 *                   name), model, workspace paths, timestamps
 *   messages.jsonl  one JSON line per payload: user, assistant, tool_call,
 *                   tool_result, ContextualHookInvoked, session_metadata,
 *                   sub_agent_start, sub_agent_complete, ...
 *   sub-executions/ the child transcripts of sub-agent runs
 *
 * The shared notes, compaction, retro, and session-log modules read a neutral
 * entry shape (`EntryLike`), so this module maps a Kiro session onto it. The
 * mapping is pure and takes the home and session id as arguments; the hooks
 * pass the real ones.
 *
 * The layout is not a documented contract. Every lookup fails soft: a missing
 * store or a bad line yields an empty session, never an exception.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EntryLike } from "../../shared/compaction/manifest.ts";
import { UNCOMMITTED } from "../../shared/review/brief.ts";
import { parseVerdict } from "../../shared/review/review.ts";

/** The session metadata this adapter reads. */
export interface SessionMeta {
	id: string;
	title?: string;
	agentMode?: string;
	modelId?: string;
	workspacePaths?: string[];
	createdAt?: string;
	lastModifiedAt?: string;
}

/** One sub-agent run, paired from its start and completion payloads. */
export interface SubAgentRun {
	subSessionId: string;
	agent: string;
	/** The brief the companion sent; a model may pass only part of the printed text. */
	prompt: string;
	/** The change key from the prompt, or from the brief in the transcript before the run. */
	key: string;
	response: string;
	status: string;
}

/** One denied tool call, with the message the blocking hook returned. */
export interface ToolDenial {
	tool: string;
	message: string;
}

/** The last credit split the session recorded. */
export interface CreditSplit {
	main: number;
	delegated: number;
	auxiliary: number;
}

/** Everything the shared modules read from one session. */
export interface SessionFacts {
	dir: string;
	meta: SessionMeta | null;
	entries: EntryLike[];
	denials: ToolDenial[];
	subAgents: SubAgentRun[];
	hooks: string[];
	credits: CreditSplit | null;
	contextUsage: number | null;
}

/** Read a JSONL file; a bad or partial line is skipped. */
export function readJsonLines(file: string): Record<string, unknown>[] {
	if (!file || !existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.flatMap((line) => {
			try {
				const parsed = JSON.parse(line) as unknown;
				return parsed && typeof parsed === "object" ? [parsed as Record<string, unknown>] : [];
			} catch {
				return [];
			}
		});
}

const SAFE_SESSION = /^sess_[A-Za-z0-9-]+$/;

/**
 * The session folder for an id under a Kiro home, or null.
 *
 * The workspace-hash folder is not derivable from the id, so the search reads
 * the `sessions/` children in name order and returns the first match. The id
 * must look like a Kiro session id: a value with a slash or `..` is refused.
 */
export function findSessionDir(kiroHome: string, sessionId: string): string | null {
	if (!SAFE_SESSION.test(sessionId)) return null;
	const root = join(kiroHome, "sessions");
	if (!existsSync(root)) return null;
	for (const name of readdirSync(root).sort()) {
		const dir = join(root, name, sessionId);
		try {
			if (statSync(dir).isDirectory() && existsSync(join(dir, "messages.jsonl"))) return dir;
		} catch {
			// A vanished or unreadable candidate is not this session.
		}
	}
	return null;
}

/** The session metadata beside a `messages.jsonl`, or null. */
export function readSessionMeta(dir: string): SessionMeta | null {
	const file = join(dir, "session.json");
	if (!existsSync(file)) return null;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as SessionMeta;
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

/** The tool names whose input path is a file the session read. */
const READ_TOOLS = new Set(["read_file", "list_directory", "file_search", "grep_search", "code"]);
/** The tool names that change a file. */
const WRITE_TOOLS = new Set(["fs_write", "fs_append", "str_replace", "delete_file"]);

/** The neutral tool-call name for a Kiro tool, or the Kiro name unchanged. */
function neutralTool(name: string): string {
	if (READ_TOOLS.has(name)) return "read";
	if (WRITE_TOOLS.has(name)) return "write";
	if (name === "execute_bash" || name === "execute_pwsh") return "bash";
	return name;
}

/** The reviewer name whose completion becomes a review entry. */
export const DEFAULT_REVIEWER = "ca-reviewer";

/** A change key line: the review brief's metadata for the commit gate. */
export const CHANGE_KEY = /Change key:\s*([0-9a-f]{16})\b/;

/** The change key line the review brief carries. */
export const changeKeyLine = (key: string): string => `Change key: ${key}`;

/** The change key in a text, or "". */
export function changeKeyIn(text: string): string {
	const match = CHANGE_KEY.exec(text);
	return match ? match[1] : "";
}

/**
 * Map the payloads of one session to the shared entry shape and the facts the
 * adapter needs.
 *
 * A `load_resource` call with `skill::<name>` becomes a read of
 * `<skillsDir>/<name>/SKILL.md`, which is the path the shared compaction
 * manifest scans for skill names. A reviewer sub-agent completion becomes a
 * `companion-agents:review` custom entry with the parsed verdict, so the shared
 * retro counts it without a second parser.
 */
export function mapPayloads(
	payloads: Record<string, unknown>[],
	options: { skillsDir?: string; reviewer?: string } = {},
): Omit<SessionFacts, "dir" | "meta"> {
	const skillsDir = options.skillsDir ?? "";
	const reviewer = options.reviewer ?? DEFAULT_REVIEWER;
	const entries: EntryLike[] = [];
	const denials: ToolDenial[] = [];
	const subAgents: SubAgentRun[] = [];
	const hooks: string[] = [];
	const pending = new Map<string, { agent: string; prompt: string; key: string }>();
	let credits: CreditSplit | null = null;
	let contextUsage: number | null = null;
	/**
	 * The last change key seen in a tool result of this turn. A model may pass
	 * only the head of the printed brief to the reviewer, so the key would be
	 * lost; the transcript keeps the whole brief. A new user message resets it.
	 */
	let lastKey = "";

	for (const payload of payloads) {
		const type = typeof payload.type === "string" ? payload.type : "";
		if (type === "user") {
			lastKey = "";
			const content = payload.content;
			if (typeof content === "string" && content.trim() !== "") {
				entries.push({ type: "message", message: { role: "user", content } });
			}
			continue;
		}
		if (type === "assistant") {
			const content = payload.content;
			if (typeof content === "string" && content.trim() !== "") {
				entries.push({ type: "message", message: { role: "assistant", content: [{ type: "text", text: content }] } });
			}
			continue;
		}
		if (type === "tool_call") {
			const kiroName = typeof payload.toolName === "string" ? payload.toolName : "";
			const args = payload.args && typeof payload.args === "object" ? (payload.args as Record<string, unknown>) : {};
			if (kiroName === "load_resource") {
				const id = typeof args.id === "string" ? args.id : "";
				const skill = id.startsWith("skill::") ? id.slice("skill::".length) : "";
				if (skill && skillsDir) {
					entries.push({
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "toolCall", name: "read", arguments: { path: join(skillsDir, skill, "SKILL.md") } }],
						},
					});
				}
				continue;
			}
			entries.push({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "toolCall", name: neutralTool(kiroName), arguments: args }],
				},
			});
			continue;
		}
		if (type === "tool_result") {
			if (payload.status === "denied") {
				denials.push({
					tool: typeof payload.title === "string" ? payload.title : "tool",
					message: typeof payload.content === "string" ? payload.content : "",
				});
			}
			if (typeof payload.content === "string") {
				// The review brief prints its scope; only a working-tree brief carries
				// a key. A ref or path review clears the earlier brief's key so the
				// next run cannot inherit it.
				const scope = /^Scope:\s*(.+)$/m.exec(payload.content);
				if (scope) lastKey = scope[1].trim() === UNCOMMITTED ? changeKeyIn(payload.content) : "";
				else {
					const found = changeKeyIn(payload.content);
					if (found) lastKey = found;
				}
			}
			continue;
		}
		if (type === "sub_agent_start") {
			const subSessionId = typeof payload.subSessionId === "string" ? payload.subSessionId : "";
			const agent = typeof payload.subAgentName === "string" ? payload.subAgentName : "";
			const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
			if (subSessionId) {
				pending.set(subSessionId, { agent, prompt, key: changeKeyIn(prompt) || lastKey });
				// The brief belongs to one run; a second run must bring its own.
				lastKey = "";
			}
			continue;
		}
		if (type === "sub_agent_complete") {
			const subSessionId = typeof payload.subSessionId === "string" ? payload.subSessionId : "";
			const start = pending.get(subSessionId);
			const agent = typeof payload.subAgentName === "string" ? payload.subAgentName : (start?.agent ?? "");
			const response = typeof payload.response === "string" ? payload.response : "";
			const status = typeof payload.status === "string" ? payload.status : "unknown";
			subAgents.push({ subSessionId, agent, prompt: start?.prompt ?? "", key: start?.key ?? "", response, status });
			if (agent === reviewer) {
				const verdict = parseVerdict(response);
				if (verdict) {
					entries.push({
						type: "custom",
						customType: "companion-agents:review",
						data: { verdict },
					});
				}
			}
			continue;
		}
		if (type === "ContextualHookInvoked") {
			if (typeof payload.name === "string") hooks.push(payload.name);
			continue;
		}
		if (type === "session_metadata") {
			if (payload.key === "creditSplit" && payload.value && typeof payload.value === "object") {
				const value = payload.value as Record<string, unknown>;
				credits = {
					main: typeof value.main === "number" ? value.main : 0,
					delegated: typeof value.delegated === "number" ? value.delegated : 0,
					auxiliary: typeof value.auxiliary === "number" ? value.auxiliary : 0,
				};
			}
			if (payload.key === "contextUsage" && payload.value && typeof payload.value === "object") {
				const value = payload.value as Record<string, unknown>;
				if (typeof value.usagePercentage === "number") contextUsage = value.usagePercentage;
			}
			continue;
		}
	}

	return { entries, denials, subAgents, hooks, credits, contextUsage };
}

/** Read one session from a Kiro home, or null when the store does not hold it. */
export function readSession(kiroHome: string, sessionId: string): SessionFacts | null {
	const dir = findSessionDir(kiroHome, sessionId);
	if (!dir) return null;
	const meta = readSessionMeta(dir);
	// The store wraps each payload as `{ id, timestamp, payload: { type, ... } }`;
	// a flat line is tolerated for fixtures and older stores.
	const payloads = readJsonLines(join(dir, "messages.jsonl")).map((line) => {
		const inner = line.payload;
		return inner && typeof inner === "object" ? (inner as Record<string, unknown>) : line;
	});
	const facts = mapPayloads(payloads, { skillsDir: join(kiroHome, "skills") });
	return { dir, meta, ...facts };
}

/** The session directory of a working directory's most recent session, for diagnostics. */
export function sessionDirs(kiroHome: string): string[] {
	const root = join(kiroHome, "sessions");
	if (!existsSync(root)) return [];
	return readdirSync(root)
		.sort()
		.flatMap((workspace) => {
			const dir = join(root, workspace);
			try {
				return readdirSync(dir)
					.filter((name) => name.startsWith("sess_") && statSync(join(dir, name)).isDirectory())
					.sort()
					.map((name) => join(dir, name));
			} catch {
				return [];
			}
		});
}
