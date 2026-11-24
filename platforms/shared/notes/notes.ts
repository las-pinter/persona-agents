/**
 * The task notes format, the lookups, and the startup read list every
 * adapter shares.
 *
 * A task notes file names the sessions that worked on its task:
 *
 *   - **Sessions:** <id>, <id>
 *
 * A session that picks the task up appends its id, so the notes file can be
 * found after a compaction without reading the harness transcript. The
 * transcript still supplies the skills and the read documents; it is not the
 * only way to the plan.
 *
 * The read list names paths and short facts, never file contents: the
 * companion reads the files itself. The scans here read the notes tree only;
 * each adapter keeps its own summary and reload wording.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { recentEntries } from "./session-log.ts";
import { isInside, taskDirs } from "./folders.ts";

/** The most recent session-log day folders read at session start. */
export const SESSION_LOG_DAYS = 3;

/** Study stages that count as unfinished. */
export const UNFINISHED_STAGES = new Set(["draft", "ready", "in-progress"]);

/** The sorted `.md` files in a folder, or [] when the folder is missing. */
export function notesFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".md") && statSync(join(dir, name)).isFile())
		.sort()
		.map((name) => join(dir, name));
}

/** The project rule files, in file-name order. */
export function projectRules(notesDir: string): string[] {
	return notesFiles(join(notesDir, "rules"));
}

/** The bullet paths under `## Pinned` in a task notes text. */
export function pinnedDocs(text: string): string[] {
	const match = /^##\s+Pinned\s*$([\s\S]*?)(?=^##\s|(?![\s\S]))/m.exec(text);
	if (!match) return [];
	return [...match[1].matchAll(/^-\s+`?([^`\s]+)`?\s*$/gm)].map((m) => m[1]).filter((p) => p.startsWith(sep));
}

/** The study path on the `Study:` line of a task notes text, or "". */
export function studyPath(text: string): string {
	const match = /^- \*\*Study:\*\*\s*`?([^`\s]+)`?/m.exec(text);
	return match && match[1].startsWith(sep) ? match[1] : "";
}

/** The session ids on the `Sessions:` line of a task notes text, in order. */
export function sessionsOf(text: string): string[] {
	const match = /^-\s+\*\*Sessions:\*\*\s*(.+)$/im.exec(text);
	if (!match) return [];
	return match[1]
		.split(/[\s,]+/)
		.map((id) => id.replace(/`/g, "").trim())
		.filter(Boolean);
}

/** True when the `Sessions:` line of a notes text names the session id. */
export function notesListsSession(text: string, sessionId: string): boolean {
	return sessionId !== "" && sessionsOf(text).includes(sessionId);
}

/** Task notes files whose Status line says open, from every task folder. */
export function openTaskNotes(notesDir: string): string[] {
	return taskDirs(notesDir).flatMap(notesFiles).filter((path) => /^- \*\*Status:\*\*\s*open\b/im.test(readFileSync(path, "utf8")));
}

/** One row of `studies/index.md`, in file order. */
export interface StudyRow {
	title: string;
	stage: string;
	/** The folder path the index writes, backticks removed. */
	path: string;
}

/**
 * The rows of `studies/index.md`. The header row and the separator row are
 * skipped. Both the read list and the review brief read the file this way, so a
 * table change lands in one parser.
 */
export function studyIndexRows(indexText: string): StudyRow[] {
	const rows: StudyRow[] = [];
	for (const line of indexText.split("\n")) {
		const cells = line.split("|").map((cell) => cell.trim());
		// | title | stage | updated | `path` |  splits to ["", title, stage, updated, path, ""]
		if (cells.length < 6) continue;
		const title = cells[1] ?? "";
		const stage = cells[2] ?? "";
		if (title === "" || title === "Study" || /^-+$/.test(stage)) continue;
		rows.push({ title, stage, path: (cells[4] ?? "").replace(/`/g, "") });
	}
	return rows;
}

/** Rows of studies/index.md whose stage is not done or abandoned: "title (stage): path". */
export function unfinishedStudies(notesDir: string): string[] {
	const index = join(notesDir, "studies", "index.md");
	if (!existsSync(index)) return [];
	return studyIndexRows(readFileSync(index, "utf8"))
		.filter((row) => UNFINISHED_STAGES.has(row.stage))
		.map((row) => `${row.title} (${row.stage}): ${join(notesDir, row.path)}`);
}

/** The matching path with the newest modification time; ties go to the first by path. */
function newestByMtime(paths: string[]): string {
	return (
		paths
			.map((path) => ({ path, at: statSync(path).mtimeMs }))
			.sort((a, b) => b.at - a.at || a.path.localeCompare(b.path))
			.at(0)?.path ?? ""
	);
}

/**
 * The active notes file for a session.
 *
 * 1. A file under `tasks/` (or the legacy `sessions/`) whose `Sessions:` line names the id, newest
 *    modification first. A session may run several tasks with one file each,
 *    so the newest match is the current task.
 * 2. The last file the session wrote under those folders.
 * 3. The only open notes file.
 * 4. "" when none applies.
 */
export function activeTaskNotes(notesDir: string, sessionId: string, written: string[]): string {
	const dirs = taskDirs(notesDir);
	if (sessionId !== "") {
		const matches = dirs.flatMap(notesFiles).filter((path) => notesListsSession(readFileSync(path, "utf8"), sessionId));
		const newest = newestByMtime(matches);
		if (newest) return newest;
	}
	const lastWritten = [...written]
		.reverse()
		.find((path) => isInside(dirs, path) && path.endsWith(".md") && existsSync(path));
	if (lastWritten) return lastWritten;
	const open = openTaskNotes(notesDir);
	return open.length === 1 ? open[0] : "";
}

const bullets = (items: string[]): string[] => (items.length ? items.map((item) => `- ${item}`) : ["- none"]);

/** The startup context text for a project notes folder. */
export function startupContext(notesDir: string, project: string, sessionId = ""): string {
	const summary = join(notesDir, "summary.md");
	const rules = projectRules(notesDir);
	const lines = [
		"# Session start: read list",
		"",
		`Project: ${project}`,
		`Project notes folder: ${notesDir}${existsSync(notesDir) ? "" : " (does not exist yet)"}`,
		...(sessionId ? [`Session id: ${sessionId}`] : []),
		"",
		"Before your first answer, read these in full (rules in this order, then the summary):",
		...bullets([...rules, ...(existsSync(summary) ? [summary] : [])]),
		"",
		`Then read the session logs of the last ${SESSION_LOG_DAYS} days with entries:`,
		...bullets(recentEntries(notesDir, SESSION_LOG_DAYS)),
		"",
		"Open task notes (read each; offer to resume or close it):",
		...bullets(openTaskNotes(notesDir)),
		"",
		"Unfinished studies (read a study only when the task names it):",
		...bullets(unfinishedStudies(notesDir)),
	];
	return lines.join("\n");
}
