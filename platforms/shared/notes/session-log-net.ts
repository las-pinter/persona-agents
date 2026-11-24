/**
 * The session-log safety net: what a session leaves behind when it ends without a
 * wrap-up.
 *
 * The wrap-up skill is the good path. When it does not run, the adapter
 * captures the material a short entry needs — the task notes the session
 * wrote, the compaction summaries, and the conversation after the last
 * compaction — and hands it to a detached writer with no tools. The writer
 * never edits code; it only writes one markdown entry.
 *
 * Caps keep the payload small: a session log cannot quote a whole session.
 */

import { existsSync, readFileSync } from "node:fs";
import { isInside, taskDirs } from "./folders.ts";
import type { EntryLike } from "../compaction/manifest.ts";

export type { EntryLike };

export interface NoteSource {
	path: string;
	text: string;
}

export interface Sources {
	notes: NoteSource[];
	summaries: string;
	tail: string;
}

export interface Payload {
	session: string;
	notesDir: string;
	/** ISO time the session ended. */
	at: string;
	/** How to start another Pi process, resolved by the extension. */
	pi?: { command: string; args: string[] };
	sources: Sources;
}

export const CAP_NOTES = 8_000;
export const CAP_SUMMARIES = 20_000;
export const CAP_TAIL = 20_000;

/** The last `max` characters of a text, marked when cut. */
export function tail(text: string, max: number): string {
	return text.length <= max ? text : `[...cut...]\n${text.slice(-max)}`;
}

/** The task notes files the session wrote, in first-write order. */
export function writtenTaskNotes(entries: EntryLike[], notesDir: string): string[] {
	const dirs = taskDirs(notesDir);
	const paths: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
		for (const block of entry.message.content) {
			const candidate = block as { type?: unknown; name?: unknown; arguments?: unknown } | null;
			if (candidate?.type !== "toolCall") continue;
			if (!["write", "edit", "patch", "apply_patch"].includes(String(candidate.name))) continue;
			const path = (candidate.arguments as { path?: unknown } | undefined)?.path;
			if (typeof path === "string" && isInside(dirs, path) && !paths.includes(path)) paths.push(path);
		}
	}
	return paths;
}

/** Every compaction summary in the branch, oldest first. */
export function compactionSummaries(entries: EntryLike[]): string[] {
	return entries.filter((entry) => entry.type === "compaction" && typeof entry.summary === "string").map((entry) => entry.summary as string);
}

/**
 * The user and assistant text after the last compaction, as `role: text`
 * lines. A message that starts with `<` is system-injected context, not the
 * conversation, so it is skipped.
 */
export function conversationTail(entries: EntryLike[]): string {
	let start = 0;
	entries.forEach((entry, index) => {
		if (entry.type === "compaction") start = index + 1;
	});
	const lines: string[] = [];
	for (const entry of entries.slice(start)) {
		if (entry.type !== "message") continue;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const content = entry.message?.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.map((block) => (block as { type?: unknown; text?: unknown } | null))
							.filter((block) => block?.type === "text" && typeof block.text === "string")
							.map((block) => String((block as { text: string }).text))
							.join("\n")
					: "";
		const trimmed = text.trim();
		if (trimmed && !trimmed.startsWith("<")) lines.push(`${role}: ${trimmed}`);
	}
	return lines.join("\n\n");
}

/** Everything a short entry can be written from. */
export function sources(entries: EntryLike[], notesDir: string): Sources {
	const notes = writtenTaskNotes(entries, notesDir)
		.filter((path) => existsSync(path))
		.map((path) => ({ path, text: tail(readFileSync(path, "utf8"), CAP_NOTES) }));
	const summaries = tail(compactionSummaries(entries).join("\n\n---\n\n"), CAP_SUMMARIES);
	const conversation = tail(conversationTail(entries), CAP_TAIL);
	return { notes, summaries, tail: conversation };
}

/** True when the sources hold anything worth an entry. */
export function hasMaterial(sources: Sources): boolean {
	return sources.notes.length > 0 || sources.summaries.trim() !== "" || sources.tail.trim() !== "";
}

/** The prompt the writer model gets. Output only the entry. */
export function writerPrompt(payload: Pick<Payload, "session" | "at">, material: Sources): string {
	const at = new Date(payload.at);
	const pad = (n: number): string => String(n).padStart(2, "0");
	const day = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
	const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
	return [
		"Write a short session log for a finished coding session, from the material below.",
		"Output only the entry, in this markdown format, at most 30 lines, plain and factual, no persona voice:",
		"",
		`# ${day} ${time} — <short title of the session>`,
		"",
		`- **Session:** ${payload.session}`,
		`- **Task notes:** ${material.notes.length ? material.notes.map((note) => note.path).join(", ") : "none"}`,
		"- **Written by:** the session-end safety net (no wrap-up)",
		"",
		"## Done",
		"## Decisions",
		"## Open",
		"",
		"Use '- none' for an empty section. Name commits, files, and studies when the material names them.",
		"",
		...material.notes.map((note) => `=== TASK NOTES ${note.path} ===\n${note.text}`),
		material.summaries ? `=== COMPACTION SUMMARIES ===\n${material.summaries}` : "",
		material.tail ? `=== CONVERSATION AFTER THE LAST COMPACTION ===\n${material.tail}` : "",
	].join("\n");
}
