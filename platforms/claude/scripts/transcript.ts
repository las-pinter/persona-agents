/**
 * Claude Code transcripts in the shape the shared modules read.
 *
 * A transcript is JSON lines: `{ type: "user" | "assistant" | "system",
 * message: { role, content }, isSidechain?, isMeta? }`, where an assistant
 * tool call is a `tool_use` block `{ name, input }`. The shared compaction
 * and session-log modules read Pi-shaped entries instead, so this maps one to
 * the other: main chain only, meta messages dropped, the file tools renamed
 * to Pi's names, and a compact boundary as a `compaction` entry.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { EntryLike } from "../../shared/compaction/manifest.ts";

/** One parsed transcript line. */
export type TranscriptEntry = Record<string, unknown>;

/** Claude Code file tools, by the Pi tool name the shared modules look for. */
const TOOL_NAMES: Record<string, string> = { Read: "read", Write: "write", Edit: "edit", MultiEdit: "edit" };

/** The parsed JSON lines of a transcript; bad lines are skipped. */
export function readTranscript(path: string | undefined): TranscriptEntry[] {
	if (!path || !existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as TranscriptEntry];
			} catch {
				return [];
			}
		});
}

/**
 * The folder the session started in: the first `cwd` its transcript records
 * on the main chain, else the fallback. Claude Code records the current folder
 * on each line, and a `cd` into an additional working directory changes it,
 * so a later `cwd` (and the hook input `cwd`) can name a folder of another
 * project or of none. Session bookkeeping lines (`mode`, `agent-setting`)
 * carry a null `cwd`, so the first string `cwd` is a conversation line.
 */
export function startDir(transcriptPath: string | undefined, fallback: string): string {
	if (!transcriptPath || !existsSync(transcriptPath)) return fallback;
	// The file is read whole; only the JSON parsing stops at the first hit,
	// which sits near the head of the transcript.
	for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
		if (!line.includes('"cwd"')) continue;
		let entry: TranscriptEntry;
		try {
			entry = JSON.parse(line) as TranscriptEntry;
		} catch {
			continue;
		}
		if (entry.isSidechain === true) continue;
		if (typeof entry.cwd === "string" && entry.cwd !== "") return entry.cwd;
	}
	return fallback;
}

/** The start folder for a hook input: from its transcript, else its `cwd`, else the process folder. */
export function hookStartDir(input: { transcript_path?: unknown; cwd?: unknown }): string {
	const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd();
	return startDir(typeof input.transcript_path === "string" ? input.transcript_path : undefined, cwd);
}

/** The transcript of a session under a Claude config folder (`<config>/projects/<dir>/<id>.jsonl`), or "". */
export function findTranscript(configDir: string, sessionId: string): string {
	if (!configDir || !/^[A-Za-z0-9_-]+$/.test(sessionId)) return "";
	const projects = join(configDir, "projects");
	if (!existsSync(projects)) return "";
	for (const dir of readdirSync(projects)) {
		const file = join(projects, dir, `${sessionId}.jsonl`);
		if (existsSync(file)) return file;
	}
	return "";
}

/** One content block in the shared shape: a file tool's `file_path` becomes `path`. */
function block(value: unknown): unknown {
	const candidate = value as { type?: unknown; name?: unknown; input?: unknown } | null;
	if (candidate?.type !== "tool_use" || typeof candidate.name !== "string") return value;
	const input = candidate.input && typeof candidate.input === "object" ? (candidate.input as Record<string, unknown>) : {};
	const name = TOOL_NAMES[candidate.name];
	if (!name) return { type: "toolCall", name: candidate.name, arguments: input };
	return { type: "toolCall", name, arguments: { ...input, path: input.file_path } };
}

/** The main-chain entries of a transcript in the shared shape. */
export function toEntries(transcript: TranscriptEntry[]): EntryLike[] {
	const entries: EntryLike[] = [];
	for (const entry of transcript) {
		if (entry.type === "system" && entry.subtype === "compact_boundary") {
			entries.push({ type: "compaction" });
			continue;
		}
		if (entry.isSidechain || entry.isMeta || (entry.type !== "user" && entry.type !== "assistant")) continue;
		const content = (entry.message as { content?: unknown } | undefined)?.content;
		entries.push({
			type: "message",
			message: { role: entry.type, content: Array.isArray(content) ? content.map(block) : content },
		});
	}
	return entries;
}
