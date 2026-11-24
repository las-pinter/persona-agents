/**
 * The Kiro review brief: what the pa-reviewer sub-agent is asked to review.
 *
 *   node review.ts ["<scope>"] [--scope=..] [--task=..] [--decisions=..]
 *                   [--cwd=..] [--home=..] [--notes=..]
 *
 * The output is the reviewer task, ending with the change key. The companion
 * passes it verbatim to the `pa-reviewer` sub-agent; the reviewer reads the
 * change from git itself. The change key is metadata for the commit gate (the
 * Stop hook records the verdict against it), never a checklist.
 *
 * The three fields and their derivation are shared with the Pi adapter. This
 * file only reads the Kiro repository, the notes tree, and git.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	buildBrief,
	deriveTask,
	finalizeBrief,
	isWorkingTreeScope,
	NO_VALUE,
	parseReviewArgs,
	promptForBrief,
	subjectsFromQueries,
	UNCOMMITTED,
	type Brief,
	type BriefInput,
} from "../../shared/review/review.ts";
import { projectDir } from "../../shared/notes/notes-paths.ts";
import { changeKey, git } from "./change.ts";
import { option } from "./argv.ts";
import { changeKeyLine } from "./session-store.ts";

/** The brief and the change it names. */
export interface ReviewBrief {
	brief: Brief;
	/** The change key the commit gate reads. */
	key: string;
	/** One line per fact the author should hear: dropped text, derived fields. */
	notes: string[];
}

/** Read a file as text, or null. */
function readText(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** Submit a git call to the shared subject helper. */
function runGit(cwd: string): (args: string[]) => Promise<{ code?: number | null; stdout?: string }> {
	return async (args) => {
		const result = git(cwd, args);
		return { code: result.status, stdout: result.stdout };
	};
}

/**
 * Build the brief from the author's input and the project notes.
 *
 * A field the author named is kept, `none` included. A missing task and
 * decisions come from the single study in progress; when no study names a
 * task, the commit subjects of the scope fill it.
 */
export async function buildReviewBrief(
	input: BriefInput,
	options: { cwd: string; notesDir: string; dropped?: string },
): Promise<ReviewBrief> {
	const { brief, dropped, given } = buildBrief(input);
	const extraDropped = (options.dropped ?? "").trim();
	const indexFile = join(options.notesDir, "studies", "index.md");
	const indexText = existsSync(indexFile) ? readText(indexFile) : "";
	const finalized = finalizeBrief(brief, given, {
		notesDir: options.notesDir,
		indexText,
		readFile: readText,
	});
	const notes = [
		...(dropped.trim() === "" ? [] : [`ignored author text: ${dropped.replace(/\s+/g, " ").trim()}`]),
		...(extraDropped === "" ? [] : [`ignored author text: ${extraDropped.replace(/\s+/g, " ").trim()}`]),
		...finalized.notes,
	];
	let task = finalized.brief.task;
	if (finalized.needsSubjects) {
		const subjects = await subjectsFromQueries(finalized.brief.scope, runGit(options.cwd));
		task = deriveTask("", "", subjects);
	}
	const { key } = changeKey(options.cwd);
	// The commit gate compares the working-tree key. A review of a named ref,
	// range, or path list did not see the whole uncommitted change, so it must
	// not unlock a commit of it. An omitted scope is the working tree, so the
	// brief carries the default and the reviewer reads what was reviewed.
	const scope = isWorkingTreeScope(finalized.brief.scope) ? UNCOMMITTED : finalized.brief.scope;
	const workingTree = isWorkingTreeScope(scope);
	if (!workingTree) notes.push("the scope is not the uncommitted change, so this review does not unlock a commit");
	return { brief: { ...finalized.brief, scope, task }, key: workingTree ? key : "", notes };
}

/** The reviewer task: the shared prompt plus the change-key line. */
export function reviewerTask(brief: ReviewBrief): string {
	const lines = [promptForBrief(brief.brief, "Kiro")];
	if (brief.key !== "") {
		lines.push("", changeKeyLine(brief.key), "This line is metadata for the commit gate, not a checklist.");
	}
	return lines.join("\n");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const args = process.argv.slice(2);
	const positional = args.filter((value) => !value.startsWith("--")).join(" ").trim();
	// A labelled argument is parsed into fields; a bare one stays raw so the
	// shared builder cuts it once and can name what it dropped.
	const labelled = /(^|\s)(scope|task|decisions)=/.test(positional);
	const parsed =
		positional === ""
			? { input: {} as BriefInput, dropped: "" }
			: labelled
				? parseReviewArgs(positional)
				: { input: { scope: positional } as BriefInput, dropped: "" };
	const input: BriefInput = { ...parsed.input };
	const scope = option("scope", process.argv);
	const task = option("task", process.argv);
	const decisions = option("decisions", process.argv);
	if (scope !== undefined) input.scope = scope;
	if (task !== undefined) input.task = task;
	if (decisions !== undefined) input.decisions = decisions;
	const cwd = option("cwd", process.argv) ?? process.cwd();
	const home = option("home", process.argv) ?? homedir();
	const notesDir = option("notes", process.argv) ?? projectDir(cwd, home);
	const brief = await buildReviewBrief(input, { cwd, notesDir, dropped: parsed.dropped });
	for (const note of brief.notes) process.stderr.write(`persona-agents: ${note}\n`);
	if (brief.brief.task === NO_VALUE) process.stderr.write("persona-agents: the brief names no task\n");
	process.stdout.write(`${reviewerTask(brief)}\n`);
}
