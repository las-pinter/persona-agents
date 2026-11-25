/**
 * What a compaction must not lose.
 *
 * Before the harness summarizes, the companion records the skills the session
 * used, the task notes file it wrote, and the documents it must read again.
 * After the summary lands, the reload list names them in order.
 *
 * The summary is lossy; the files are not. This manifest is the bridge: it says
 * which files to re-read, so the plan survives a compaction because it is on
 * disk, not because the summary happened to keep it.
 *
 * It is built from Pi's structured session entries, never by scraping a
 * transcript: `{ type: "message", message: { role, content } }`, where an
 * assistant tool call is `{ type: "toolCall", name, arguments }`.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { isInside, sessionLogsDir, tasksDir } from "../notes/folders.ts";
import { activeTaskNotes, pinnedDocs, projectRules, studyPath } from "../notes/notes.ts";

/** The cap on skills reloaded after one compaction. */
export const MAX_SKILLS = 12;
/** The cap on documents reloaded after one compaction. */
export const MAX_DOCS = 20;

/** The part of a Pi session entry the shared modules read, plus a compaction summary. */
export interface EntryLike {
	type?: string;
	summary?: string;
	message?: { role?: string; content?: unknown };
	customType?: string;
	data?: unknown;
}

export interface Manifest {
	/** The current session id, or "". */
	session: string;
	/** The active task notes file, or "". */
	taskNotes: string;
	/** Skill names, in the order they were last used. */
	skills: string[];
	/** Absolute document paths to read again. */
	docs: string[];
}

export interface ToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

/** The tool calls of the main chain, in order. */
export function toolCalls(entries: EntryLike[]): ToolCall[] {
	const calls: ToolCall[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (!block || typeof block !== "object") continue;
			const candidate = block as { type?: unknown; name?: unknown; arguments?: unknown };
			if (candidate.type !== "toolCall" || typeof candidate.name !== "string") continue;
			const args = candidate.arguments;
			calls.push({ name: candidate.name, arguments: args && typeof args === "object" ? (args as Record<string, unknown>) : {} });
		}
	}
	return calls;
}

/** The text of the user and assistant messages, for finding `/skill:name`. */
function messageTexts(entries: EntryLike[]): string[] {
	const texts: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const content = entry.message?.content;
		if (typeof content === "string") texts.push(content);
		else if (Array.isArray(content)) {
			for (const block of content) {
				const text = (block as { type?: unknown; text?: unknown } | null)?.text;
				if (typeof text === "string") texts.push(text);
			}
		}
	}
	return texts;
}

/** The skill name a read path names, or null: `…/skills/<name>/SKILL.md`. */
export function skillOfPath(path: string): string | null {
	const match = /[/\\]skills[/\\]([^/\\]+)[/\\]SKILL\.md$/.exec(path);
	return match ? match[1] : null;
}

/** The last `max` distinct values, ordered by their last use. */
export function lastDistinct(values: string[], max: number): string[] {
	const seen = new Map<string, number>();
	values.forEach((value, index) => seen.set(value, index));
	return [...seen.entries()]
		.sort((a, b) => a[1] - b[1])
		.map(([value]) => value)
		.slice(-max);
}

/** The reload manifest for one branch and one project notes folder. */
export function buildManifest(entries: EntryLike[], notesDir: string, sessionId = ""): Manifest {
	const calls = toolCalls(entries);
	const readPaths = calls
		.filter((call) => call.name === "read" || call.name === "grep")
		.map((call) => (typeof call.arguments.path === "string" ? call.arguments.path : ""))
		.filter((path) => path !== "");

	// Skills: a SKILL.md the session read, or `/skill:<name>` in its text.
	const skillsFromReads = readPaths.map(skillOfPath).filter((name): name is string => name !== null);
	const skillsFromText = messageTexts(entries).flatMap((text) => [...text.matchAll(/\/skill:([a-z0-9-]+)/g)].map((match) => match[1]));
	const skills = lastDistinct([...skillsFromReads, ...skillsFromText], MAX_SKILLS);

	const written = calls
		.filter((call) => ["write", "edit", "patch", "apply_patch"].includes(call.name))
		.map((call) => (typeof call.arguments.path === "string" ? call.arguments.path : ""));
	return { session: sessionId, skills, ...reloadFiles(notesDir, sessionId, written, readPaths) };
}

/**
 * The task notes file and the documents to reload, from the paths a session
 * wrote and read. Every adapter extracts the paths from its own transcript
 * and shares this choice.
 */
export function reloadFiles(notesDir: string, sessionId: string, written: string[], readPaths: string[]): { taskNotes: string; docs: string[] } {
	// The active notes file: the session-id match first, then the last one the
	// session wrote, then the only open notes file.
	const tasks = tasksDir(notesDir);
	const writtenNotes = written.filter((path) => isInside(tasks, path) && path.endsWith(".md"));
	const taskNotes = activeTaskNotes(notesDir, sessionId, writtenNotes);
	const notesText = taskNotes && existsSync(taskNotes) ? readFileSync(taskNotes, "utf8") : "";

	// Documents: project rules and summary, notes the session read, the linked
	// study, then the pinned ones. Session logs and other tasks are not
	// reloaded: their content is history, not the plan.
	const startup = [...projectRules(notesDir), join(notesDir, "summary.md")].filter((path) => existsSync(path));
	const readNotes = readPaths.filter(
		(path) =>
			path.startsWith(notesDir + sep) && !isInside(sessionLogsDir(notesDir), path) && !isInside(tasks, path),
	);
	const study = studyPath(notesText);
	const docs = lastDistinct([...readNotes, ...startup, ...(study ? [study] : []), ...pinnedDocs(notesText)], MAX_DOCS).filter(
		(path) => path !== taskNotes,
	);
	return { taskNotes, docs };
}

/** The focus the summary must follow. Passed to Pi's own summarizer. */
export function summaryInstructions(manifest: Pick<Manifest, "taskNotes">): string {
	const lines = [
		"Compaction instructions from the companion-agents companion:",
		"- Keep the current task, the current plan step, the open decisions, and the owner's latest request word for word where short.",
		"- Do not paraphrase skill text or project rules; they are reloaded after compaction.",
	];
	if (manifest.taskNotes) lines.push(`- Keep this exact path in the summary: the task notes file ${manifest.taskNotes}`);
	return lines.join("\n");
}

/** Pi's skill step: a skill is reloaded by reading its file. */
export const READ_SKILLS_STEP = "2. Re-read these skills (their `SKILL.md`):";

/** The message sent right after a compaction: what to reload, in order. */
export function reloadContext(manifest: Pick<Manifest, "taskNotes" | "skills" | "docs"> & { session?: string }, skillStep = READ_SKILLS_STEP): string {
	const lines = [
		"# After compaction: reload before you continue",
		"",
		"Do every step below before any other work, even when the summary seems to cover it: the summary is lossy, the files are not.",
	];
	if (manifest.session) lines.push("", `Session id: ${manifest.session}`);
	lines.push("");
	lines.push(
		manifest.taskNotes
			? `1. Read the task notes file first; it holds the plan: ${manifest.taskNotes}`
			: "1. No task notes file was found for this session.",
	);
	lines.push(skillStep);
	lines.push(...(manifest.skills.length ? manifest.skills.map((skill) => `   - ${skill}`) : ["   - none"]));
	lines.push("3. Re-read these documents in full:");
	lines.push(...(manifest.docs.length ? manifest.docs.map((doc) => `   - ${doc}`) : ["   - none"]));
	lines.push("4. Do not re-read working source files now; read them again when the next step needs them.");
	return lines.join("\n");
}
