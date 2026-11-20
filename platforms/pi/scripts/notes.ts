/**
 * The companion's notes: the startup read list, and the open-work scans.
 *
 * The read list sends paths and short facts, never file contents: the
 * companion reads the files itself, so the text stays small and the model
 * decides what it needs. The same list is sent after a compaction (the reload
 * list), with the session notes file first.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { openSessionNotes, projectRules, unfinishedStudies } from "../../shared/notes/notes.ts";
import { recentEntries } from "./journal.ts";

/** The most recent journal day folders read at session start. */
export const JOURNAL_DAYS = 3;

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
