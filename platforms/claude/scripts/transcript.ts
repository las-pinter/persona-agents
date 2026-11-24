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

import { existsSync, readFileSync } from "node:fs";
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
