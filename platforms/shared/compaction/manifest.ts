/**
 * What a compaction must not lose.
 *
 * Before the harness summarizes, the companion records the skills the session
 * used, the session notes file it wrote, and the documents it must read again.
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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";

/** The cap on skills reloaded after one compaction. */
export const MAX_SKILLS = 12;
/** The cap on documents reloaded after one compaction. */
export const MAX_DOCS = 20;

/** The part of a Pi session entry this module reads. */
export interface EntryLike {
	type?: string;
	message?: { role?: string; content?: unknown };
	customType?: string;
	data?: unknown;
}

export interface Manifest {
	/** The session notes file the session wrote last, or "". */
	sessionNotes: string;
	/** Skill names, in the order they were last used. */
	skills: string[];
	/** Absolute document paths to read again. */
	docs: string[];
}

interface ToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

/** The tool calls of the main chain, in order. */
function toolCalls(entries: EntryLike[]): ToolCall[] {
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
function lastDistinct(values: string[], max: number): string[] {
	const seen = new Map<string, number>();
	values.forEach((value, index) => seen.set(value, index));
	return [...seen.entries()]
		.sort((a, b) => a[1] - b[1])
		.map(([value]) => value)
		.slice(-max);
}

/** The bullet paths under `## Pinned` in a session notes text. */
export function pinnedDocs(text: string): string[] {
	const match = /^##\s+Pinned\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(text);
	if (!match) return [];
	return [...match[1].matchAll(/^-\s+`?([^`\s]+)`?\s*$/gm)].map((item) => item[1]).filter((path) => path.startsWith(sep));
}

/** The study path on the `Study:` line of a session notes text, or "". */
export function studyPath(text: string): string {
	const match = /^- \*\*Study:\*\*\s*`?([^`\s]+)`?/m.exec(text);
	return match && match[1].startsWith(sep) ? match[1] : "";
}

/** A folder's `.md` files, sorted, or [] when the folder is missing. */
function mdFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".md"))
		.sort()
		.map((name) => join(dir, name));
}

/** The reload manifest for one branch and one project notes folder. */
export function buildManifest(entries: EntryLike[], notesDir: string): Manifest {
	const calls = toolCalls(entries);
	const readPaths = calls
		.filter((call) => call.name === "read" || call.name === "grep")
		.map((call) => (typeof call.arguments.path === "string" ? call.arguments.path : ""))
		.filter((path) => path !== "");

	// Skills: a SKILL.md the session read, or `/skill:<name>` in its text.
	const skillsFromReads = readPaths.map(skillOfPath).filter((name): name is string => name !== null);
	const skillsFromText = messageTexts(entries).flatMap((text) => [...text.matchAll(/\/skill:([a-z0-9-]+)/g)].map((match) => match[1]));
	const skills = lastDistinct([...skillsFromReads, ...skillsFromText], MAX_SKILLS);

	// The session notes file: the last one written under sessions/.
	const sessionsDir = join(notesDir, "sessions") + sep;
	const written = calls
		.filter((call) => ["write", "edit", "patch", "apply_patch"].includes(call.name))
		.map((call) => (typeof call.arguments.path === "string" ? call.arguments.path : ""))
		.filter((path) => path.startsWith(sessionsDir) && path.endsWith(".md"));
	const sessionNotes = written.at(-1) ?? "";
	const notesText = sessionNotes && existsSync(sessionNotes) ? readFileSync(sessionNotes, "utf8") : "";

	// Documents: project rules and summary, notes the session read, the linked
	// study, then the pinned ones. Journal entries and other sessions are not
	// reloaded: their content is history, not the plan.
	const startup = [...mdFiles(join(notesDir, "rules")), join(notesDir, "summary.md")].filter((path) => existsSync(path));
	const readNotes = readPaths.filter(
		(path) =>
			path.startsWith(notesDir + sep) && !path.startsWith(join(notesDir, "journal") + sep) && !path.startsWith(sessionsDir),
	);
	const study = studyPath(notesText);
	const docs = lastDistinct([...readNotes, ...startup, ...(study ? [study] : []), ...pinnedDocs(notesText)], MAX_DOCS).filter(
		(path) => path !== sessionNotes,
	);

	return { sessionNotes, skills, docs };
}

/** The focus the summary must follow. Passed to Pi's own summarizer. */
export function summaryInstructions(manifest: Manifest): string {
	const lines = [
		"Compaction instructions from the persona-agents companion:",
		"- Keep the current task, the current plan step, the open decisions, and the owner's latest request word for word where short.",
		"- Do not paraphrase skill text or project rules; they are reloaded after compaction.",
	];
	if (manifest.sessionNotes) lines.push(`- Keep this exact path in the summary: the session notes file ${manifest.sessionNotes}`);
	return lines.join("\n");
}

/** The message sent right after a compaction: what to reload, in order. */
export function reloadContext(manifest: Manifest): string {
	const lines = [
		"# After compaction: reload before you continue",
		"",
		"Do every step below before any other work, even when the summary seems to cover it: the summary is lossy, the files are not.",
		"",
	];
	lines.push(
		manifest.sessionNotes
			? `1. Read the session notes file first; it holds the plan: ${manifest.sessionNotes}`
			: "1. No session notes file was found for this session.",
	);
	lines.push("2. Re-read these skills (their `SKILL.md`):");
	lines.push(...(manifest.skills.length ? manifest.skills.map((skill) => `   - ${skill}`) : ["   - none"]));
	lines.push("3. Re-read these documents in full:");
	lines.push(...(manifest.docs.length ? manifest.docs.map((doc) => `   - ${doc}`) : ["   - none"]));
	lines.push("4. Do not re-read working source files now; read them again when the next step needs them.");
	return lines.join("\n");
}
