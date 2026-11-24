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

import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { prepareBrief, type GitRun } from "../../shared/review/brief.ts";
import { NO_VALUE, parseReviewArgs, promptForBrief, type Brief, type BriefInput } from "../../shared/review/review.ts";
import { projectDir } from "../../shared/notes/notes-paths.ts";
import { changeKey, git } from "./change.ts";
import { option } from "../../shared/argv.ts";
import { changeKeyLine } from "./session-store.ts";

/** The brief and the change it names. */
export interface ReviewBrief {
	brief: Brief;
	/** The change key the commit gate reads. */
	key: string;
	/** One line per fact the author should hear: dropped text, derived fields. */
	notes: string[];
}

/** Ask git in the repository for the shared brief builder. */
function runGit(cwd: string): GitRun {
	return async (args) => {
		const result = git(cwd, args);
		return { code: result.status, stdout: result.stdout };
	};
}

/**
 * Build the brief from the author's input and the project notes, with the
 * change key the commit gate reads when the review covers the working tree.
 */
export async function buildReviewBrief(
	input: BriefInput,
	options: { cwd: string; notesDir: string; dropped?: string },
): Promise<ReviewBrief> {
	const prepared = await prepareBrief(input, { notesDir: options.notesDir, git: runGit(options.cwd), dropped: options.dropped });
	const key = prepared.workingTree ? changeKey(options.cwd).key : "";
	return { brief: prepared.brief, key, notes: prepared.notes };
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
