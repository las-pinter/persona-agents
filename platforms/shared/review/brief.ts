/**
 * The brief one review starts from, built the same way on every adapter.
 *
 * The author's fields are cut once, the missing ones are filled from the
 * project notes, and git is asked for commit subjects only when the notes name
 * no task and the scope has commits of its own. The notes say what the author
 * should hear: text that was dropped, and a scope that cannot unlock a commit.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	buildBrief,
	deriveTask,
	finalizeBrief,
	isWorkingTreeScope,
	oneLine,
	subjectsFromQueries,
	UNCOMMITTED,
	type Brief,
	type BriefInput,
} from "./review.ts";

/** Run git in the repository: the exit code and the output. */
export type GitRun = (args: string[]) => Promise<{ code?: number | null; stdout?: string }>;

/** A brief, the notes that go beside it, and whether it covers the uncommitted change. */
export interface PreparedBrief {
	brief: Brief;
	notes: string[];
	/** True when the review saw the whole uncommitted change, so it may unlock a commit. */
	workingTree: boolean;
}

/** The note for author text the brief dropped. */
export const droppedNote = (dropped: string): string => `ignored brief text: "${oneLine(dropped, 200)}"`;

/** The note for a review that cannot unlock a commit. */
export const NOT_WORKING_TREE_NOTE = "the scope is not the uncommitted change, so this review does not unlock a commit";

/** Read a file as text, or null when it cannot be read. */
function readText(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/**
 * Build the brief from the author's input and the project notes. `dropped` is
 * text the caller already removed before the fields, named back in the notes.
 */
export async function prepareBrief(input: BriefInput, options: { notesDir: string; git: GitRun; dropped?: string }): Promise<PreparedBrief> {
	const prepared = buildBrief(input);
	const indexPath = join(options.notesDir, "studies", "index.md");
	// Absent is normal (""), unreadable is not (null), and the two are not the same note.
	const indexText = existsSync(indexPath) ? readText(indexPath) : "";
	const finalized = finalizeBrief(prepared.brief, prepared.given, { notesDir: options.notesDir, indexText, readFile: readText });
	let brief = finalized.brief;
	// An empty scope is the uncommitted change: it has no commits of its own,
	// so subjectsFromQueries asks git nothing for it.
	if (finalized.needsSubjects) {
		brief = { ...brief, task: deriveTask("", "", await subjectsFromQueries(brief.scope, options.git)) };
	}
	const workingTree = isWorkingTreeScope(brief.scope);
	// The brief carries the default scope, so the reviewer reads what was reviewed.
	if (workingTree) brief = { ...brief, scope: UNCOMMITTED };
	const notes = [...finalized.notes];
	const dropped = [prepared.dropped, options.dropped ?? ""].map((part) => part.trim()).filter((part) => part !== "").join("\n");
	if (dropped !== "") notes.push(droppedNote(dropped));
	if (!workingTree) notes.push(NOT_WORKING_TREE_NOTE);
	return { brief, notes, workingTree };
}
