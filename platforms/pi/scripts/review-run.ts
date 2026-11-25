/**
 * The review on Pi: read the change, run the reviewer in its own process,
 * remember the verdict for the exact change, and ask before an unreviewed
 * commit.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { changeFromGit, DIFF_ARGS, GIT_OPTIONS, isCleanTree, SHOW_ARGS, STATUS_ARGS } from "../../shared/review/change.ts";
import { reviewerBody } from "./review-body.ts";
import { prepareBrief, promptForBrief, type Brief, type BriefInput } from "../../shared/review/brief.ts";
import { commitGate, isTrivial, parseVerdict, reviewerFailure, reviewKey, REVIEWER_TIMEOUT_MS, type Change, type Verdict as ReviewVerdict } from "../../shared/review/review.ts";
import { type Session } from "./session.ts";

/** The extension entry point the reviewer child loads. */
export const EXTENSION_FILE = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));

/** The command and arguments that start another Pi process. */
export function piInvocation(): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && existsSync(script)) return { command: process.execPath, args: [script] };
	return { command: "pi", args: [] };
}

/** The change a commit would record: the diff, the changed paths, and a signature of their content. */
async function readChange(pi: ExtensionAPI, cwd: string): Promise<Change> {
	const run = (args: string[]) => pi.exec("git", [...GIT_OPTIONS, ...args], { cwd });
	const status = await run(STATUS_ARGS);
	let diff = await run(DIFF_ARGS);
	if (isCleanTree(status, diff)) diff = await run(SHOW_ARGS);
	return changeFromGit(cwd, status, diff);
}

/** Run the reviewer in its own process: read-only tools, its own profile, its own gate. */
async function runReviewer(
	pi: ExtensionAPI,
	cwd: string,
	brief: Brief,
	signal?: AbortSignal,
): Promise<{ text: string; verdict: ReviewVerdict | null }> {
	const invocation = piInvocation();
	const result = await pi.exec(
		invocation.command,
		[
			...invocation.args,
			// The child loads this extension explicitly, so the reviewer profile and
			// its policy apply even when the package is not installed.
			"--extension",
			EXTENSION_FILE,
			"-p",
			"--no-session",
			"--agent",
			"companion-agents:reviewer",
			"--tools",
			"read,grep,find,ls,bash",
			"--append-system-prompt",
			reviewerBody(),
			promptForBrief(brief),
		],
		{ cwd, timeout: REVIEWER_TIMEOUT_MS, signal },
	);
	const failure = reviewerFailure({ ...result, aborted: signal?.aborted === true });
	if (failure !== "") throw new Error(failure);
	const text = result.stdout.trim();
	return { text, verdict: parseVerdict(text) };
}

/** A review request: the fields the caller holds, and the text it dropped. */
interface ReviewRequest {
	input: BriefInput;
	/** Text the caller removed before the fields, named back in the result. */
	dropped?: string;
}

/**
 * Run a review, remember its verdict for the exact change, and return the
 * reviewer's text with the key and the notes that belong beside it.
 */
export async function executeReview(
	pi: ExtensionAPI,
	session: Session,
	request: ReviewRequest,
	signal?: AbortSignal,
): Promise<{ text: string; verdict: ReviewVerdict | null; key: string; notes: string[] }> {
	const change = await readChange(pi, session.env.cwd);
	const prepared = await prepareBrief(request.input, {
		notesDir: session.env.notesDir,
		git: async (args) => pi.exec("git", args, { cwd: session.env.cwd }),
		dropped: request.dropped,
	});
	// Only a review of the whole working tree unlocks a commit of it. A named
	// ref, range, or path list did not see the uncommitted change.
	const key = prepared.workingTree ? reviewKey(change) : "";
	const notes = prepared.notes;
	const { text, verdict } = await runReviewer(pi, session.env.cwd, prepared.brief, signal);
	if (verdict && key !== "") {
		session.reviews.set(key, verdict);
		pi.appendEntry("companion-agents:review", { at: new Date().toISOString(), key, verdict, files: change.files });
	}
	return { text, verdict, key, notes };
}

/** The ask when a commit has no covering review. */
export async function reviewGate(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	session: Session,
): Promise<{ block: true; reason: string } | undefined> {
	if (session.skipReview) return undefined;
	let change: Change;
	try {
		change = await readChange(pi, session.env.cwd);
	} catch {
		// A failed read is unknown, not trivial: ask rather than allow silently.
		return { block: true, reason: "the change could not be read, so this commit needs your approval" };
	}
	const key = reviewKey(change);
	const gate = commitGate({ trivial: isTrivial(change), reviewed: session.reviews.get(key) ?? null });
	if (gate.verdict === "allow") return undefined;
	if (!ctx.hasUI) return { block: true, reason: gate.reason };
	const shape = `${change.files.length} files, +${change.addedLines} -${change.removedLines}`;
	const choice = await ctx.ui.select(`${gate.reason}\n\n${shape}`, [
		"Run the review now",
		"Commit anyway",
		"Always allow this session",
		"Cancel",
	]);
	if (choice === "Commit anyway") return undefined;
	if (choice === "Always allow this session") {
		session.skipReview = true;
		return undefined;
	}
	if (choice === "Run the review now") {
		try {
			const { text, verdict, notes } = await executeReview(pi, session, { input: {} });
			const extra = notes.map((note) => `\n${note}`).join("");
			return { block: true, reason: `review finished: ${verdict ?? "no verdict"}. Fix what it asks, then commit again.\n\n${text}${extra}` };
		} catch (error) {
			return { block: true, reason: `the review could not run: ${(error as Error).message}` };
		}
	}
	return { block: true, reason: gate.reason };
}
