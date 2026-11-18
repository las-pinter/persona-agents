/**
 * The companion's notes: the startup read list, and the open-work scans.
 *
 * The read list sends paths and short facts, never file contents: the
 * companion reads the files itself, so the text stays small and the model
 * decides what it needs. The same list is sent after a compaction (the reload
 * list), with the session notes file first.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { recentEntries } from "./journal.ts";

/** The most recent journal day folders read at session start. */
export const JOURNAL_DAYS = 3;
/** Study stages that count as unfinished. */
export const UNFINISHED_STAGES = new Set(["draft", "ready", "in-progress"]);

/** The sorted names in a folder that pass `keep`, or [] when the folder is missing. */
function list(dir: string, keep: (name: string, path: string) => boolean): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => keep(name, join(dir, name)))
		.sort();
}

const isFile = (path: string): boolean => statSync(path).isFile();

/** Session notes files whose Status line says open. */
export function openSessionNotes(notesDir: string): string[] {
	return list(join(notesDir, "sessions"), (name) => name.endsWith(".md"))
		.map((name) => join(notesDir, "sessions", name))
		.filter((path) => isFile(path) && /^- \*\*Status:\*\*\s*open\b/im.test(readFileSync(path, "utf8")));
}

/** Rows of studies/index.md whose stage is not done or abandoned: "title (stage): path". */
export function unfinishedStudies(notesDir: string): string[] {
	const index = join(notesDir, "studies", "index.md");
	if (!existsSync(index)) return [];
	const rows: string[] = [];
	for (const line of readFileSync(index, "utf8").split("\n")) {
		const cells = line.split("|").map((cell) => cell.trim());
		// | title | stage | updated | `path` |  splits to ["", title, stage, updated, path, ""]
		if (cells.length < 6 || !UNFINISHED_STAGES.has(cells[2])) continue;
		rows.push(`${cells[1]} (${cells[2]}): ${join(notesDir, cells[4].replace(/`/g, ""))}`);
	}
	return rows;
}

/** The project rules files, in read order. */
export function projectRules(notesDir: string): string[] {
	return list(join(notesDir, "rules"), (name) => name.endsWith(".md")).map((name) => join(notesDir, "rules", name));
}

const bullets = (items: string[]): string[] => (items.length ? items.map((item) => `- ${item}`) : ["- none"]);

/** The startup context text for a project notes folder. */
export function startupContext(notesDir: string, project: string): string {
	const summary = join(notesDir, "summary.md");
	const rules = projectRules(notesDir);
	const lines = [
		"# Session start: read list",
		"",
		`Project: ${project}`,
		`Project notes folder: ${notesDir}${existsSync(notesDir) ? "" : " (does not exist yet)"}`,
		"",
		"Before your first answer, read these in full (rules in this order, then the summary):",
		...bullets([...rules, ...(existsSync(summary) ? [summary] : [])]),
		"",
		`Then read the journal of the last ${JOURNAL_DAYS} days with entries:`,
		...bullets(recentEntries(notesDir, JOURNAL_DAYS)),
		"",
		"Open session notes (read each; offer to resume or close it):",
		...bullets(openSessionNotes(notesDir)),
		"",
		"Unfinished studies (read a study only when the task names it):",
		...bullets(unfinishedStudies(notesDir)),
	];
	return lines.join("\n");
}
